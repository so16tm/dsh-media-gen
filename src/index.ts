/**
 * dsh-media-gen: image and video generation for DeepSeek Harness that reuses
 * the providers and credentials already configured in DSH.
 * @module dsh-media-gen
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-credentials'
import { boundContextSummary, createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import {
  describeJob, MemoryJobStore, openDomainStore, VideoJobWatcher, type JobStore, type StorageDomainService, type VideoJobRecord,
} from './jobs.ts'
import { formatCost, formatCostRange, localized, t } from './messages.ts'
import { ProviderBridge, type CredentialResolver } from './provider-bridge.ts'
import { MediaService, type ImageArgs } from './service.ts'
import { registerTools, TOOL_GENERATE_IMAGE, TOOL_GENERATE_VIDEO } from './tools.ts'
import type { VideoArgs } from './video.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'plugin:dsh-media-gen': { kind: 'plugin:dsh-media-gen' } & ContextFormed
  }
}

/** Stable Loader identity. */
export const name = 'dsh-media-gen'

/**
 * Required services. Credentials, settings, attachments, the working
 * directory, the storage domain, and the agent registry are optional.
 */
export const inject = ['tools', 'llm']

/** Plugin configuration. */
export interface Config {
  /** Default DSH provider id for image generation. */
  defaultImageProvider: Volatile<string | undefined>
  /** Default image model id, e.g. one listed by media_list_models. */
  defaultImageModel: Volatile<string | undefined>
  /** Upper bound of images per call. */
  maxImagesPerCall: Volatile<number>
  /** Default DSH provider id for video generation. */
  defaultVideoProvider: Volatile<string | undefined>
  /** Default video model id. */
  defaultVideoModel: Volatile<string | undefined>
  /** Longest video duration a call may request, in seconds. */
  maxVideoSeconds: Volatile<number>
  /** Ask the user before every billed generation. */
  requireApproval: Volatile<boolean>
  /** Output directory relative to the session working directory. */
  outputDir: string
  /** How long a model listing stays fresh. */
  catalogTtlMs: number
  /** Per-request timeout for provider calls. */
  requestTimeoutMs: number
  /** Largest accepted generated image. */
  maxImageBytes: number
  /** Interval between checks of running video jobs. */
  videoPollIntervalMs: Volatile<number>
  /** How long after submission a video job is watched. */
  videoMaxWatchMs: Volatile<number>
  /** Largest accepted generated video. */
  maxVideoBytes: Volatile<number>
  /** Tell the session when a video job ends. */
  notifyOnVideoCompletion: Volatile<boolean>
}

/** Validated configuration with defaults. */
export const Config = z.object({
  defaultImageProvider: z.string().volatile(),
  defaultImageModel: z.string().volatile(),
  maxImagesPerCall: z.natural().min(1).max(10).default(4).volatile(),
  defaultVideoProvider: z.string().volatile(),
  defaultVideoModel: z.string().volatile(),
  maxVideoSeconds: z.natural().min(1).max(120).default(10).volatile(),
  requireApproval: z.boolean().default(true).volatile(),
  outputDir: z.string().default('generated-media'),
  catalogTtlMs: z.natural().default(10 * 60_000),
  requestTimeoutMs: z.natural().min(1).default(180_000),
  maxImageBytes: z.natural().min(1).default(30 * 1024 * 1024),
  videoPollIntervalMs: z.natural().min(5_000).default(30_000).volatile(),
  videoMaxWatchMs: z.natural().min(60_000).default(3 * 60 * 60_000).volatile(),
  maxVideoBytes: z.natural().min(1).default(500 * 1024 * 1024).volatile(),
  notifyOnVideoCompletion: z.boolean().default(true).volatile(),
})

/** Live agent surface used to report finished video jobs. */
interface AgentLike {
  readonly status: string
  readonly session: { readonly id: string }
  followup(message: unknown): void
  inject(message: unknown): void
}

/** Session-keyed registry of live agents. */
interface AgentRegistry {
  get(sessionId: string): AgentLike | undefined
}

/** Message source of this plugin's in-session notices. */
const SOURCE_KIND = 'plugin:dsh-media-gen'

/** Prompt excerpt length shown in the approval prompt. */
const PROMPT_PREVIEW = 200

/**
 * Register the media tools and the cost-approval gate.
 * @param ctx - plugin context.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const bridge = new ProviderBridge({
    llm: ctx.llm,
    get settings() { return ctx.get('settings') },
    get credentials() { return ctx.get('credentials') as CredentialResolver | undefined },
  })
  // Volatile fields are read on every use so settings edits apply without a reload.
  const service = new MediaService(bridge, () => ({
    defaultImageProvider: config.defaultImageProvider.get(),
    defaultImageModel: config.defaultImageModel.get(),
    maxImagesPerCall: config.maxImagesPerCall.get(),
    defaultVideoProvider: config.defaultVideoProvider.get(),
    defaultVideoModel: config.defaultVideoModel.get(),
    maxVideoSeconds: config.maxVideoSeconds.get(),
  }), { catalogTtlMs: config.catalogTtlMs, requestTimeoutMs: config.requestTimeoutMs })

  // Provider edits invalidate cached listings so a changed endpoint or key is used at once.
  ctx.on('llm/adapters-updated', () => service.catalog.clear())

  const get = (name: string): unknown => (ctx as unknown as { get(name: string): unknown }).get(name)

  // Reports a finished job: an idle session gets a new turn, a busy one sees it at its next step.
  const notify = (record: VideoJobRecord, wake: boolean): boolean => {
    if (!config.notifyOnVideoCompletion.get()) return true
    if (record.sessionId === undefined) return true
    const agent = (get('agents') as AgentRegistry | undefined)?.get(record.sessionId)
    if (agent === undefined) return false
    const message = createUserMessage({
      content: [{ type: 'text', text: describeJob(record) }],
      source: {
        kind: SOURCE_KIND,
        form: 'notice',
        summary: boundContextSummary(`Video job ${record.status === 'completed' ? 'finished' : record.status}: ${record.modelName}`),
      },
    })
    if (wake && agent.status === 'idle') agent.followup(message)
    else agent.inject(message)
    return true
  }

  const storageDomain = get('storageDomain') as StorageDomainService | undefined
  const store: Promise<JobStore> = storageDomain === undefined
    ? Promise.resolve(new MemoryJobStore())
    : openDomainStore(storageDomain).catch((error: unknown) => {
      ctx.logger.warn(`dsh-media-gen: video jobs will not survive a restart; job storage failed to open: ${String(error)}`)
      return new MemoryJobStore()
    })
  const videoJobs = store.then((jobs) => {
    const watcher = new VideoJobWatcher(jobs, service, () => ({
      pollIntervalMs: config.videoPollIntervalMs.get(),
      maxWatchMs: config.videoMaxWatchMs.get(),
      maxVideoBytes: config.maxVideoBytes.get(),
    }), record => notify(record, true), ctx.logger)
    watcher.start()
    return watcher
  })
  ctx.effect(() => async () => {
    const watcher = await videoJobs
    await watcher.dispose()
    await watcher.store.close?.()
  })

  // Outcomes that finished while their session was closed are handed over when it opens again.
  ;(ctx as unknown as { on(name: string, fn: (payload: { agent: AgentLike }) => void): void })
    .on('agent/created', ({ agent }) => {
      void videoJobs.then(async (watcher) => {
        for (const record of watcher.store.list()) {
          if (record.delivered || record.sessionId !== agent.session.id) continue
          if (notify(record, false)) await watcher.store.put({ ...record, delivered: true })
        }
      })
    })

  registerTools(ctx, service, {
    outputDir: config.outputDir,
    maxImageBytes: config.maxImageBytes,
    videoJobs,
    maxWatchMs: () => config.videoMaxWatchMs.get(),
  })

  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const decision = await next()
    if (!config.requireApproval.get() || decision.kind !== 'allow') return decision
    if (exec.name !== TOOL_GENERATE_IMAGE && exec.name !== TOOL_GENERATE_VIDEO) return decision
    const args = exec.arguments as { prompt?: unknown }
    if (typeof args?.prompt !== 'string') return decision
    const prompt = args.prompt.length > PROMPT_PREVIEW ? `${args.prompt.slice(0, PROMPT_PREVIEW)}…` : args.prompt
    let text: (lang: Parameters<typeof t>[0]) => string
    try {
      if (exec.name === TOOL_GENERATE_IMAGE) {
        const plan = await service.plan(args as ImageArgs, exec.signal)
        const cost = await service.estimate(plan, exec.signal)
        text = lang => t(lang, 'approval.image', {
          count: String(plan.count), model: plan.model.name, provider: plan.provider.id, cost: formatCost(lang, cost),
        })
      } else {
        const plan = await service.planVideo(args as VideoArgs, exec.signal)
        const cost = service.estimateVideo(plan)
        const duration = plan.params.duration
        text = lang => t(lang, typeof duration === 'number' ? 'approval.video' : 'approval.video.default', {
          model: plan.model.name, provider: plan.provider.id, cost: formatCostRange(lang, cost), seconds: String(duration),
        })
      }
    } catch {
      // An invalid request fails in execute with its classified error, before any charge.
      return decision
    }
    const full = (lang: Parameters<typeof t>[0]) => `${text(lang)}\n${t(lang, 'approval.prompt', { prompt })}`
    return { kind: 'ask', reason: full('en'), displayReason: localized(full) }
  })
}
