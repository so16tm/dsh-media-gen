/**
 * VideoJobs: durable records of submitted video jobs and the watcher that
 * polls them, downloads finished videos, and reports the outcome. Records
 * outlive the Host process when DSH's storage domain is available, so a
 * restart resumes watching instead of losing a paid job.
 * @module dsh-media-gen/src/jobs
 */
import { mkdir } from 'node:fs/promises';
import { MediaError } from "./errors.js";
import { slug, timestamp, writeNewFile } from "./output.js";
import { openDomain } from "./storage.js";
import { isTerminal, sniffVideo } from "./video.js";
/** Whether the watcher still has work for this job. */
export function isActive(record) {
    if (record.status === 'completed')
        return record.files.length === 0;
    return record.status !== 'stopped' && !isTerminal(record.status);
}
/** Process-local store used when DSH offers no storage domain. */
export class MemoryJobStore {
    durable = false;
    records = new Map();
    list() { return [...this.records.values()]; }
    get(id) { return this.records.get(id); }
    async put(record) { this.records.set(record.id, record); }
}
const STATUSES = new Set(['pending', 'in_progress', 'completed', 'failed', 'cancelled', 'expired', 'stopped']);
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/**
 * Validate one stored record. The storage domain calls `parse` on every
 * record at open; a malformed record throws and is reported by DSH.
 */
export const jobRecordSchema = {
    parse(raw) {
        if (!isRecord(raw))
            throw new Error('video job record must be an object');
        const strings = ['id', 'providerId', 'model', 'modelName', 'prompt', 'dir', 'createdAt', 'updatedAt', 'watchUntil'];
        for (const key of strings) {
            if (typeof raw[key] !== 'string')
                throw new Error(`video job record field ${key} must be a string`);
        }
        if (typeof raw.status !== 'string' || !STATUSES.has(raw.status))
            throw new Error('video job record has an unknown status');
        if (!isRecord(raw.params) || !Array.isArray(raw.files))
            throw new Error('video job record is missing params or files');
        if (typeof raw.outputs !== 'number' || typeof raw.delivered !== 'boolean' || typeof raw.failures !== 'number') {
            throw new Error('video job record has malformed counters');
        }
        return raw;
    },
};
/** Storage-domain declaration of the job records. */
export const JOB_DOMAIN = {
    name: 'media_gen',
    version: 1,
    tables: { video_jobs: { valueSchema: jobRecordSchema } },
};
/** Open the durable job store. */
export async function openDomainStore(service, attempts = 10, delayMs = 200) {
    const domain = await openDomain(service, JOB_DOMAIN, attempts, delayMs);
    const table = domain.table('video_jobs');
    return {
        durable: true,
        list: () => [...table.entries()].map(([, value]) => value),
        get: id => table.get(id),
        put: record => table.put(record.id, record),
        close: () => domain.close(),
    };
}
/** Consecutive check failures after which watching stops. */
export const MAX_FAILURES = 10;
/** Polls active jobs, saves finished videos, and reports outcomes. */
export class VideoJobWatcher {
    store;
    provider;
    settings;
    notify;
    logger;
    now;
    timer;
    running;
    stopped = false;
    checking = new Map();
    constructor(store, provider, settings, notify, logger = console, now = Date.now) {
        this.store = store;
        this.provider = provider;
        this.settings = settings;
        this.notify = notify;
        this.logger = logger;
        this.now = now;
    }
    /** Start polling, e.g. after the store opened; resumes jobs left by an earlier run. */
    start() {
        this.schedule(0);
    }
    /** Stop polling and wait for a running round. */
    async dispose() {
        this.stopped = true;
        if (this.timer !== undefined)
            clearTimeout(this.timer);
        await this.running?.catch(() => undefined);
    }
    /** Record a newly submitted job and make sure it is watched. */
    async add(record) {
        await this.store.put(record);
        if (this.timer === undefined && this.running === undefined)
            this.schedule(this.settings().pollIntervalMs);
    }
    schedule(delay) {
        if (this.stopped)
            return;
        if (this.timer !== undefined)
            clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.running = this.round().finally(() => {
                this.running = undefined;
                if (this.store.list().some(isActive))
                    this.schedule(this.settings().pollIntervalMs);
            });
        }, delay);
        this.timer.unref?.();
    }
    /** One pass over every active job, then a retry of undelivered outcomes. */
    async round() {
        for (const record of this.store.list()) {
            if (this.stopped)
                return;
            if (!isActive(record))
                continue;
            try {
                await this.check(record.id);
            }
            catch (error) {
                this.logger.warn(`dsh-media-gen: video job ${record.id} check failed: ${String(error)}`);
            }
        }
        await this.deliverPending();
    }
    /**
     * Check one job now, saving its videos once complete. Concurrent checks of
     * one job share a single request. A stopped job is checked again, so the
     * user can recover a job that finished after watching ended.
     */
    check(id, signal) {
        const pending = this.checking.get(id);
        if (pending !== undefined)
            return pending;
        const run = this.checkOnce(id, signal).finally(() => this.checking.delete(id));
        this.checking.set(id, run);
        return run;
    }
    async checkOnce(id, signal) {
        const record = this.store.get(id);
        if (record === undefined)
            throw new MediaError('INVALID_REQUEST', `no video job "${id}" is known`);
        if (record.status === 'completed' && record.files.length > 0)
            return record;
        if (record.status !== 'stopped' && isTerminal(record.status))
            return record;
        const settings = this.settings();
        let next;
        try {
            const state = await this.provider.getVideoJob(record.providerId, record.id, signal);
            next = {
                ...record,
                status: state.status,
                outputs: state.outputs,
                failures: 0,
                ...state.error === undefined ? {} : { error: state.error },
                ...state.costUsd === undefined ? {} : { costUsd: state.costUsd },
            };
            if (state.status === 'completed') {
                next = { ...next, files: await this.save(next, settings.maxVideoBytes, signal) };
                delete next.error;
            }
        }
        catch (error) {
            if (signal?.aborted)
                throw error;
            const message = error instanceof Error ? error.message : String(error);
            next = { ...record, failures: record.failures + 1, error: message };
            if (next.failures >= MAX_FAILURES)
                next = { ...next, status: 'stopped', error: `watching stopped after ${MAX_FAILURES} failed checks: ${message}` };
        }
        // A job checked again after watching stopped gets a fresh watch window.
        if (record.status === 'stopped' && isActive(next))
            next = { ...next, watchUntil: new Date(this.now() + settings.maxWatchMs).toISOString() };
        else if (isActive(next) && this.now() > Date.parse(record.watchUntil)) {
            next = {
                ...next,
                status: 'stopped',
                error: `watching stopped ${Math.round(settings.maxWatchMs / 60_000)} minutes after submission; the provider job may still finish`,
            };
        }
        next.updatedAt = new Date(this.now()).toISOString();
        // Every new outcome is reported once, including one reached after a stop.
        if (!isActive(next) && (next.status !== record.status || next.files.length !== record.files.length))
            next.delivered = false;
        await this.store.put(next);
        if (!isActive(next) && !next.delivered)
            await this.deliver(next);
        return this.store.get(id) ?? next;
    }
    async save(record, maxBytes, signal) {
        const downloads = [];
        for (let index = 0; index < Math.max(record.outputs, 1); index++) {
            const { data, contentType } = await this.provider.downloadVideo(record.providerId, record.id, index, maxBytes, signal);
            const kind = sniffVideo(data)
                ?? (contentType?.startsWith('video/') === true ? { mediaType: contentType.split(';')[0].trim(), extension: 'mp4' } : undefined);
            if (kind === undefined)
                throw new MediaError('INVALID_RESPONSE', 'the provider returned content that is not a recognized video');
            downloads.push({ data, ...kind });
        }
        await mkdir(record.dir, { recursive: true });
        const stem = `${timestamp(new Date(this.now()))}-${slug(record.model)}`;
        const saved = [];
        for (const [index, item] of downloads.entries()) {
            const path = await writeNewFile(record.dir, `${stem}-${index + 1}`, item.extension, item.data);
            saved.push({ path, mediaType: item.mediaType, bytes: item.data.byteLength });
        }
        return saved;
    }
    async deliver(record) {
        let delivered = false;
        try {
            delivered = this.notify(record);
        }
        catch (error) {
            this.logger.warn(`dsh-media-gen: could not report video job ${record.id}: ${String(error)}`);
        }
        if (delivered)
            await this.store.put({ ...record, delivered: true });
    }
    /** Retry outcomes that could not reach their session earlier. */
    async deliverPending(sessionId) {
        for (const record of this.store.list()) {
            if (isActive(record) || record.delivered)
                continue;
            if (sessionId !== undefined && record.sessionId !== sessionId)
                continue;
            await this.deliver(record);
        }
    }
}
/**
 * Model-facing account of a job's outcome or progress.
 * @param record - the job.
 */
export function describeJob(record) {
    const head = `Video job ${record.id} (${record.model}, provider ${record.providerId})`;
    const cost = record.costUsd === undefined ? '' : ` Cost: ${record.costUsd} USD.`;
    switch (record.status) {
        case 'pending':
        case 'in_progress':
            return `${head} is ${record.status === 'pending' ? 'queued' : 'generating'}. You will be notified when it finishes; do not poll it.`;
        case 'completed':
            return record.files.length > 0
                ? `${head} finished. Saved:\n${record.files.map(f => `- ${f.path} (${f.mediaType}, ${f.bytes} bytes)`).join('\n')}\n${cost.trim()}`.trim()
                    + '\nIn your reply, show the user the video by calling the present tool with its path; the chat plays it in the preview.'
                : `${head} finished, but saving the video has not succeeded yet${record.error === undefined ? '' : `: ${record.error}`}. It will be retried.`;
        case 'stopped':
            return `${head}: ${record.error ?? 'watching stopped'}. This is not a cancellation; call media_video_status with this job_id to check it again.`;
        default:
            return `${head} ended with status ${record.status}${record.error === undefined ? '' : `: ${record.error}`}.${cost}`;
    }
}
