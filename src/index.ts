/**
 * dsh-media-gen: image (and later video) generation for DeepSeek Harness that
 * reuses the providers and credentials already configured in DSH.
 * @module dsh-media-gen
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import { formatCost, localized, t } from './messages.ts'
import { ProviderBridge, type CredentialResolver } from './provider-bridge.ts'
import { MediaService, type ImageArgs } from './service.ts'
import { registerTools, TOOL_GENERATE_IMAGE } from './tools.ts'

/** Stable Loader identity. */
export const name = 'dsh-media-gen'

/** Required services; credentials, settings, attachments, and the working directory are optional. */
export const inject = ['tools', 'llm']

/** Plugin configuration. */
export interface Config {
  /** Default DSH provider id for image generation. */
  defaultImageProvider: Volatile<string | undefined>
  /** Default image model id, e.g. one listed by media_list_models. */
  defaultImageModel: Volatile<string | undefined>
  /** Upper bound of images per call. */
  maxImagesPerCall: Volatile<number>
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
}

/** Validated configuration with defaults. */
export const Config = z.object({
  defaultImageProvider: z.string().volatile(),
  defaultImageModel: z.string().volatile(),
  maxImagesPerCall: z.natural().min(1).max(10).default(4).volatile(),
  requireApproval: z.boolean().default(true).volatile(),
  outputDir: z.string().default('generated-media'),
  catalogTtlMs: z.natural().default(10 * 60_000),
  requestTimeoutMs: z.natural().min(1).default(180_000),
  maxImageBytes: z.natural().min(1).default(30 * 1024 * 1024),
})

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
  }), { catalogTtlMs: config.catalogTtlMs, requestTimeoutMs: config.requestTimeoutMs })

  // Provider edits invalidate cached listings so a changed endpoint or key is used at once.
  ctx.on('llm/adapters-updated', () => service.catalog.clear())

  registerTools(ctx, service, { outputDir: config.outputDir, maxImageBytes: config.maxImageBytes })

  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const decision = await next()
    if (exec.name !== TOOL_GENERATE_IMAGE || !config.requireApproval.get() || decision.kind !== 'allow') return decision
    const args = exec.arguments as ImageArgs
    if (typeof args?.prompt !== 'string') return decision
    let summary: { provider: string; model: string; count: number; cost: number | undefined }
    try {
      const plan = await service.plan(args, exec.signal)
      summary = { provider: plan.provider.id, model: plan.model.name, count: plan.count, cost: await service.estimate(plan, exec.signal) }
    } catch {
      // An invalid request fails in execute with its classified error, before any charge.
      return decision
    }
    const prompt = args.prompt.length > PROMPT_PREVIEW ? `${args.prompt.slice(0, PROMPT_PREVIEW)}…` : args.prompt
    const text = (lang: Parameters<typeof t>[0]) => [
      t(lang, 'approval.image', { count: String(summary.count), model: summary.model, provider: summary.provider, cost: formatCost(lang, summary.cost) }),
      t(lang, 'approval.image.prompt', { prompt }),
    ].join('\n')
    return { kind: 'ask', reason: text('en'), displayReason: localized(text) }
  })
}
