/**
 * Generate: one image generation or one video submission, shared by the
 * model-facing tools and the direct `/image` and `/video` commands.
 * @module dsh-media-gen/src/generate
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { VideoJobRecord, VideoJobWatcher } from './jobs.ts'
import type { MediaFileIndex } from './media-files.ts'
import { MediaError } from './errors.ts'
import { resolveOutputDir, saveImages } from './output.ts'
import { loadInputImage, loadInputImages, type ImageCompat } from './input-images.ts'
import type { ImagePlan, LoadedVideoInputs, MediaService, VideoPlan } from './service.ts'

/** Prompt excerpt stored with a video job. */
const PROMPT_EXCERPT = 200

/** The calling agent and the request's cancellation. */
export interface Caller {
  agent?: unknown
  signal?: AbortSignal | undefined
}

/** Working-directory service of DSH 0.2.1 and later; absent in 0.2.0. */
interface WorkingDirectoryService {
  ensure(agent: unknown, signal?: AbortSignal): Promise<string>
}

/** Session id of the calling agent, when it runs inside one. */
export function sessionIdOf(caller: Pick<Caller, 'agent'>): string | undefined {
  const id = (caller.agent as { session?: { id?: unknown } } | undefined)?.session?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * Resolve the session working directory. DSH 0.2.1 provides a
 * `workingDirectory` service; 0.2.0 records it on the session header. A
 * deployment with neither falls back to the Host process directory.
 */
export async function workingDirectory(ctx: Context, caller: Caller): Promise<string> {
  const agent = caller.agent as { session?: { header?: { cwd?: unknown } } } | undefined
  const service = (ctx as unknown as { get(name: string): unknown }).get('workingDirectory') as WorkingDirectoryService | undefined
  if (service !== undefined && agent !== undefined) return service.ensure(agent, caller.signal)
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
}

/** The `imageCompat` service of dsh-small-improvements, when installed. */
function imageCompat(ctx: Context): ImageCompat | undefined {
  return (ctx as unknown as { get(name: string): unknown }).get('imageCompat') as ImageCompat | undefined
}

/** Output settings generation needs. */
export interface GenerateConfig {
  outputDir: string
  maxImageBytes: number
  videoJobs: Promise<VideoJobWatcher>
  maxWatchMs: () => number
  /** Index the chat's media views read saved images from. */
  mediaFiles?: Promise<MediaFileIndex>
}

/** Canonical value of one image generation. */
export interface ImageToolValue {
  provider: string
  model: string
  images: { path: string; mediaType: string; bytes: number; attachment?: Record<string, unknown> }[]
  costUsd: number | null
  staleCatalog: boolean
  attachmentFailures: number
  /** Why a later variation failed after earlier images were saved. */
  failed?: string
}

/**
 * Mark a failure after which the provider may already have billed the request:
 * a timeout, or a response that could not be used. The agent must not retry it
 * on its own.
 */
function maybeCharged(error: unknown): Error {
  if (!(error instanceof MediaError) || (error.code !== 'TIMEOUT' && error.code !== 'INVALID_RESPONSE')) {
    return error instanceof Error ? error : new Error(String(error))
  }
  return new MediaError(error.code, `${error.message}; the provider may still have charged for this request, so do not retry without asking the user`, {
    ...error.status === undefined ? {} : { status: error.status }, cause: error,
  })
}

/**
 * Generate and save the images of one plan: the prompt, then each
 * variation, one provider call each. A failure after an image was saved
 * stops the rest and is reported with what was saved.
 * @param prompt - the text sent to the model, unchanged.
 */
export async function runImagePlan(
  ctx: Context, service: MediaService, config: GenerateConfig, plan: ImagePlan, prompt: string, caller: Caller,
): Promise<ImageToolValue> {
  const cwd = await workingDirectory(ctx, caller)
  const dir = resolveOutputDir(cwd, config.outputDir)
  // Inputs are read before the request, so a missing file fails before anything is billed.
  const inputs = await loadInputImages(plan.inputs, cwd, imageCompat(ctx))
  const attachments: AttachmentStore | undefined = ctx.get('attachments')
  const saved: Awaited<ReturnType<typeof saveImages>>['saved'] = []
  let attachmentFailures = 0
  let costUsd: number | null = 0
  let failed: string | undefined
  const index = config.mediaFiles === undefined ? undefined : await config.mediaFiles
  const total = 1 + plan.variations.length
  for (const [n, text] of [prompt, ...plan.variations].entries()) {
    try {
      const result = await service.generate(plan, text, caller.signal, inputs)
      // A response arrived, so this request is billed even if saving fails.
      costUsd = costUsd === null || result.costUsd === null ? null : costUsd + result.costUsd
      const batch = await saveImages(result.images.map(i => i.data), {
        dir, model: plan.model.id, attachments, maxBytes: config.maxImageBytes,
      })
      saved.push(...batch.saved)
      attachmentFailures += batch.attachmentFailures
      // Index at once, so images saved before a later failure still show in the chat.
      // The images are saved either way; a failed entry only hides them from the chat view.
      if (index !== undefined) await Promise.all(batch.saved.map(i => index.add(i.path, { mediaType: i.mediaType, bytes: i.bytes }).catch(() => {})))
    } catch (error) {
      if (saved.length === 0) throw maybeCharged(error)
      failed = `image ${n + 1} of ${total} failed: ${maybeCharged(error).message}`
      break
    }
  }
  return {
    provider: plan.provider.id,
    model: plan.model.id,
    images: saved.map(s => ({
      path: s.path,
      mediaType: s.mediaType,
      bytes: s.bytes,
      ...s.attachment === undefined ? {} : { attachment: s.attachment as unknown as Record<string, unknown> },
    })),
    costUsd,
    staleCatalog: plan.staleCatalog,
    attachmentFailures,
    ...failed === undefined ? {} : { failed },
  }
}

/**
 * Submit one planned video job and hand it to the watcher.
 * @param prompt - the text sent to the model, unchanged.
 * @param origin - who asked: the agent's tool call or the user's command.
 */
export async function startVideoPlan(
  ctx: Context, service: MediaService, config: GenerateConfig, plan: VideoPlan, prompt: string, caller: Caller,
  origin: 'agent' | 'command',
): Promise<VideoJobRecord> {
  const cwd = await workingDirectory(ctx, caller)
  const dir = resolveOutputDir(cwd, config.outputDir)
  const watcher = await config.videoJobs
  const compat = imageCompat(ctx)
  const inputs: LoadedVideoInputs = {
    ...plan.inputs.first === undefined ? {} : { first: await loadInputImage(plan.inputs.first, cwd, undefined, compat) },
    ...plan.inputs.last === undefined ? {} : { last: await loadInputImage(plan.inputs.last, cwd, undefined, compat) },
    references: await loadInputImages(plan.inputs.references, cwd, compat),
  }
  const state = await service.submitVideo(plan, prompt, caller.signal, inputs)
  const now = new Date()
  const estimate = service.estimateVideo(plan)
  const sessionId = sessionIdOf(caller)
  const record: VideoJobRecord = {
    id: state.id,
    providerId: plan.provider.id,
    model: plan.model.id,
    modelName: plan.model.name,
    prompt: prompt.slice(0, PROMPT_EXCERPT),
    params: plan.params,
    ...sessionId === undefined ? {} : { sessionId },
    origin,
    dir,
    status: state.status,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    watchUntil: new Date(now.getTime() + config.maxWatchMs()).toISOString(),
    ...estimate === undefined ? {} : { estimate },
    outputs: state.outputs,
    files: [],
    delivered: false,
    failures: 0,
  }
  // The job is already billed at the provider, so a storage failure must not hide its id.
  try {
    await watcher.add(record)
  } catch (error) {
    return { ...record, status: 'stopped', error: `the job could not be recorded for watching: ${String(error)}` }
  }
  return record
}
