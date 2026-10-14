import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  describeJob, isActive, jobRecordSchema, MAX_FAILURES, MemoryJobStore, openDomainStore, VideoJobWatcher,
  type JobProvider, type VideoJobRecord,
} from '../src/jobs.ts'
import { MediaError } from '../src/errors.ts'
import type { StorageDomainService } from '../src/storage.ts'
import type { VideoJobStatus } from '../src/video.ts'

const MP4 = Uint8Array.from([0, 0, 0, 0x18, ...new TextEncoder().encode('ftypisom'), 1, 2, 3])
const T0 = Date.parse('2026-10-14T09:00:00Z')

function record(dir: string, overrides: Partial<VideoJobRecord> = {}): VideoJobRecord {
  return {
    id: 'job-1', providerId: 'openrouter', model: 'google/veo-3.1', modelName: 'Veo 3.1', prompt: 'a wave',
    params: { duration: 4 }, sessionId: 's1', dir, status: 'pending',
    createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(),
    watchUntil: new Date(T0 + 60 * 60_000).toISOString(),
    outputs: 0, files: [], delivered: false, failures: 0, ...overrides,
  }
}

function harness(states: (VideoJobStatus | Error)[], notifyResult = true, content: Uint8Array = MP4, contentType = 'video/mp4') {
  let now = T0
  const queue = [...states]
  const notified: VideoJobRecord[] = []
  let downloads = 0
  const provider: JobProvider = {
    async getVideoJob() {
      const next = queue.length > 1 ? queue.shift()! : queue[0]!
      if (next instanceof Error) throw next
      return next === 'completed' ? { status: next, outputs: 1, costUsd: 0.8 } : next === 'failed' ? { status: next, outputs: 0, error: 'policy' } : { status: next, outputs: 0 }
    },
    async downloadVideo() {
      downloads += 1
      return { data: content, contentType }
    },
  }
  const store = new MemoryJobStore()
  const watcher = new VideoJobWatcher(store, provider, () => ({ pollIntervalMs: 1000, maxWatchMs: 60 * 60_000, maxVideoBytes: 1000 }),
    (r) => { notified.push(r); return notifyResult }, { warn: () => {} }, () => now)
  return { store, watcher, notified, setNow: (t: number) => { now = t }, downloads: () => downloads }
}

describe('VideoJobWatcher', () => {
  it('polls until completion, saves the video once, and reports it once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'media-'))
    const h = harness(['in_progress', 'completed'])
    await h.store.put(record(dir))
    expect((await h.watcher.check('job-1')).status).toBe('in_progress')
    expect(h.notified).toHaveLength(0)
    const done = await h.watcher.check('job-1')
    expect(done.status).toBe('completed')
    expect(done.costUsd).toBe(0.8)
    expect(done.files).toHaveLength(1)
    expect(done.files[0]?.path).toMatch(/google-veo-3-1-1\.mp4$/u)
    expect(await readFile(done.files[0]!.path)).toEqual(Buffer.from(MP4))
    expect(done.delivered).toBe(true)
    await h.watcher.check('job-1')
    await h.watcher.round()
    expect(h.downloads()).toBe(1)
    expect(h.notified).toHaveLength(1)
  })

  it('reports provider failures with their message', async () => {
    const h = harness(['failed'])
    await h.store.put(record(await mkdtemp(join(tmpdir(), 'media-'))))
    const failed = await h.watcher.check('job-1')
    expect(failed).toMatchObject({ status: 'failed', error: 'policy' })
    expect(describeJob(failed)).toContain('ended with status failed: policy')
    expect(isActive(failed)).toBe(false)
  })

  it('keeps a job active through transient errors and stops after repeated ones', async () => {
    const h = harness([new MediaError('RATE_LIMITED', 'slow down')])
    await h.store.put(record(await mkdtemp(join(tmpdir(), 'media-'))))
    expect(await h.watcher.check('job-1')).toMatchObject({ status: 'pending', failures: 1 })
    for (let i = 1; i < MAX_FAILURES; i++) await h.watcher.check('job-1')
    const stopped = h.store.get('job-1')!
    expect(stopped.status).toBe('stopped')
    expect(describeJob(stopped)).toContain('This is not a cancellation')
    expect(h.notified).toHaveLength(1)
  })

  it('stops watching after the window and resumes when checked by hand', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'media-'))
    const h = harness(['in_progress', 'in_progress', 'completed'])
    await h.store.put(record(dir))
    h.setNow(T0 + 2 * 60 * 60_000)
    expect(await h.watcher.check('job-1')).toMatchObject({ status: 'stopped' })
    const revived = await h.watcher.check('job-1')
    expect(revived.status).toBe('in_progress')
    expect(Date.parse(revived.watchUntil)).toBe(T0 + 3 * 60 * 60_000)
    const done = await h.watcher.check('job-1')
    expect(done.status).toBe('completed')
    // The stop and the later completion are each reported.
    expect(h.notified.map(r => r.status)).toEqual(['stopped', 'completed'])
  })

  it('keeps an undeliverable outcome until its session can take it', async () => {
    const h = harness(['failed'], false)
    await h.store.put(record(await mkdtemp(join(tmpdir(), 'media-'))))
    await h.watcher.check('job-1')
    expect(h.store.get('job-1')?.delivered).toBe(false)
    await h.watcher.deliverPending('other-session')
    expect(h.notified).toHaveLength(1)
    await h.watcher.deliverPending('s1')
    expect(h.notified).toHaveLength(2)
  })

  it('refuses content that is not a video', async () => {
    const h = harness(['completed'], true, new TextEncoder().encode('<html>'), 'text/html')
    await h.store.put(record(await mkdtemp(join(tmpdir(), 'media-'))))
    const result = await h.watcher.check('job-1')
    expect(result.files).toEqual([])
    expect(result.error).toContain('not a recognized video')
    expect(isActive(result)).toBe(true)
  })
})

describe('job storage', () => {
  it('validates stored records', () => {
    expect(jobRecordSchema.parse(record('/d'))).toMatchObject({ id: 'job-1' })
    expect(() => jobRecordSchema.parse({ ...record('/d'), status: 'done' })).toThrow()
    expect(() => jobRecordSchema.parse({ id: 'x' })).toThrow()
  })

  it('opens the storage domain, retrying while a previous instance is still closing', async () => {
    const rows = new Map<string, VideoJobRecord>()
    let attempts = 0
    const service: StorageDomainService = {
      async open(spec) {
        expect(spec.name).toBe('media_gen')
        attempts += 1
        if (attempts < 3) throw Object.assign(new Error('busy'), { code: 'already-open' })
        return {
          table: () => ({
            get: (k: string) => rows.get(k),
            entries: () => rows.entries(),
            put: async (k: string, v: unknown) => { rows.set(k, v as VideoJobRecord) },
            delete: async (k: string) => rows.delete(k),
          }),
          close: async () => {},
        }
      },
    }
    const store = await openDomainStore(service, 5, 1)
    expect(store.durable).toBe(true)
    await store.put(record('/d'))
    expect(store.list().map(r => r.id)).toEqual(['job-1'])
    expect(attempts).toBe(3)
    await expect(openDomainStore({ open: async () => { throw new Error('broken') } }, 5, 1)).rejects.toThrow('broken')
  })
})
