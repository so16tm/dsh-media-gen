/**
 * VideoJobs: durable records of submitted video jobs and the watcher that
 * polls them, downloads finished videos, and reports the outcome. Records
 * outlive the Host process when DSH's storage domain is available, so a
 * restart resumes watching instead of losing a paid job.
 * @module dsh-media-gen/src/jobs
 */
import { type StorageDomainService } from './storage.ts';
import { type CostRange, type VideoJobStatus } from './video.ts';
/** Local status: the provider's, plus `stopped` when this plugin gave up watching. */
export type JobStatus = VideoJobStatus | 'stopped';
/** One saved video file. */
export interface SavedVideo {
    path: string;
    mediaType: string;
    bytes: number;
}
/** Durable record of one submitted video job. */
export interface VideoJobRecord {
    /** Provider job id. */
    id: string;
    providerId: string;
    model: string;
    modelName: string;
    /** Prompt excerpt, for status listings. */
    prompt: string;
    params: Record<string, string | number | boolean>;
    /** Session that asked for the video, when known. */
    sessionId?: string;
    /** Who started the job: the agent's tool call or the user's `/video` command. Absent on older records. */
    origin?: 'agent' | 'command';
    /** Absolute directory the outputs are written to. */
    dir: string;
    status: JobStatus;
    createdAt: string;
    updatedAt: string;
    /** When the watcher gives up polling unless the job is checked again by hand. */
    watchUntil: string;
    error?: string;
    costUsd?: number;
    estimate?: CostRange;
    /** Outputs the provider reported. */
    outputs: number;
    files: SavedVideo[];
    /** Whether the outcome reached the session. */
    delivered: boolean;
    /** Consecutive failed checks. */
    failures: number;
}
/** Whether the watcher still has work for this job. */
export declare function isActive(record: VideoJobRecord): boolean;
/** Persistence of job records. */
export interface JobStore {
    list(): VideoJobRecord[];
    get(id: string): VideoJobRecord | undefined;
    put(record: VideoJobRecord): Promise<void>;
    /** True when records survive a Host restart. */
    readonly durable: boolean;
    close?(): Promise<void>;
}
/** Process-local store used when DSH offers no storage domain. */
export declare class MemoryJobStore implements JobStore {
    readonly durable = false;
    private readonly records;
    list(): VideoJobRecord[];
    get(id: string): VideoJobRecord | undefined;
    put(record: VideoJobRecord): Promise<void>;
}
/**
 * Validate one stored record. The storage domain calls `parse` on every
 * record at open; a malformed record throws and is reported by DSH.
 */
export declare const jobRecordSchema: {
    parse(raw: unknown): VideoJobRecord;
};
/** Storage-domain declaration of the job records. */
export declare const JOB_DOMAIN: {
    readonly name: "media_gen";
    readonly version: 1;
    readonly tables: {
        readonly video_jobs: {
            readonly valueSchema: {
                parse(raw: unknown): VideoJobRecord;
            };
        };
    };
};
/** Open the durable job store. */
export declare function openDomainStore(service: StorageDomainService, attempts?: number, delayMs?: number): Promise<JobStore>;
/** Provider calls the watcher needs, bound to one provider id. */
export interface JobProvider {
    getVideoJob(providerId: string, jobId: string, signal?: AbortSignal): Promise<{
        status: VideoJobStatus;
        error?: string;
        outputs: number;
        costUsd?: number;
    }>;
    downloadVideo(providerId: string, jobId: string, index: number, maxBytes: number, signal?: AbortSignal): Promise<{
        data: Uint8Array;
        contentType?: string;
    }>;
}
/** Watcher settings, read again on every round. */
export interface WatchSettings {
    pollIntervalMs: number;
    /** How long after submission the watcher keeps polling. */
    maxWatchMs: number;
    maxVideoBytes: number;
}
/** Consecutive check failures after which watching stops. */
export declare const MAX_FAILURES = 10;
/**
 * Delivers a finished job to its session.
 * @returns true when the outcome reached the session.
 */
export type Notifier = (record: VideoJobRecord) => boolean;
/** Polls active jobs, saves finished videos, and reports outcomes. */
export declare class VideoJobWatcher {
    readonly store: JobStore;
    private readonly provider;
    private readonly settings;
    private readonly notify;
    private readonly logger;
    private readonly now;
    private timer;
    private running;
    private stopped;
    private readonly checking;
    constructor(store: JobStore, provider: JobProvider, settings: () => WatchSettings, notify: Notifier, logger?: {
        warn(message: string): void;
    }, now?: () => number);
    /** Start polling, e.g. after the store opened; resumes jobs left by an earlier run. */
    start(): void;
    /** Stop polling and wait for a running round. */
    dispose(): Promise<void>;
    /** Record a newly submitted job and make sure it is watched. */
    add(record: VideoJobRecord): Promise<void>;
    private schedule;
    /** One pass over every active job, then a retry of undelivered outcomes. */
    round(): Promise<void>;
    /**
     * Check one job now, saving its videos once complete. Concurrent checks of
     * one job share a single request. A stopped job is checked again, so the
     * user can recover a job that finished after watching ended.
     */
    check(id: string, signal?: AbortSignal): Promise<VideoJobRecord>;
    private checkOnce;
    private save;
    private deliver;
    /** Retry outcomes that could not reach their session earlier. */
    deliverPending(sessionId?: string): Promise<void>;
}
/**
 * Model-facing account of a job's outcome or progress.
 * @param record - the job.
 */
export declare function describeJob(record: VideoJobRecord): string;
