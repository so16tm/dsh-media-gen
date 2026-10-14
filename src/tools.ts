/**
 * MediaTools: the model-facing tools. Descriptions are English because DSH
 * sends one tool description to every model regardless of display language.
 * @module dsh-media-gen/src/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ParameterSpec } from './openrouter.ts'
import { resolveOutputDir, saveImages } from './output.ts'
import type { MediaService } from './service.ts'

/** Wire names of the tools; stable across languages. */
export const TOOL_LIST_MODELS = 'media_list_models'
export const TOOL_GENERATE_IMAGE = 'media_generate_image'

/** Output settings the image tool needs. */
export interface ToolConfig {
  outputDir: string
  maxImageBytes: number
}

function describeSpec(spec: ParameterSpec): string {
  switch (spec.kind) {
    case 'enum': return spec.values.join('|')
    case 'range': return `${spec.min ?? ''}..${spec.max ?? ''}`
    case 'boolean': return 'true|false'
    case 'any': return 'any'
  }
}

/** Working-directory service of DSH 0.2.1 and later; absent in 0.2.0. */
interface WorkingDirectoryService {
  ensure(agent: unknown, signal?: AbortSignal): Promise<string>
}

/**
 * Resolve the session working directory. DSH 0.2.1 provides a
 * `workingDirectory` service; 0.2.0 records it on the session header. A
 * deployment with neither falls back to the Host process directory.
 */
async function workingDirectory(ctx: Context, exec: ToolExecution): Promise<string> {
  const agent = exec.agent as { session?: { header?: { cwd?: unknown } } } | undefined
  const service = (ctx as unknown as { get(name: string): unknown }).get('workingDirectory') as WorkingDirectoryService | undefined
  if (service !== undefined && agent !== undefined) return service.ensure(agent, exec.signal)
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
}

/**
 * Register the media tools.
 * @param ctx - plugin context.
 * @param service - shared media service.
 * @param config - output settings.
 */
export function registerTools(ctx: Context, service: MediaService, config: ToolConfig): void {
  ctx.tools.register(defineTool({
    name: TOOL_LIST_MODELS,
    description: 'List the image generation models available through the providers configured in DeepSeek Harness, '
      + 'with the parameters each model accepts. Call this before media_generate_image when no model is known.',
    parameters: {
      provider: { type: 'string', description: 'DSH provider id; omit to list every media-capable provider.' },
      refresh: { type: 'boolean', description: 'Bypass the cached listing.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const providers = args.provider === undefined ? service.bridge.listProviders() : [service.bridge.pick(args.provider)]
      if (providers.length === 0) service.bridge.pick()
      const out = []
      for (const provider of providers) {
        const snapshot = await service.imageModels(provider, { refresh: args.refresh === true, signal: exec.signal })
        out.push({
          provider: provider.id,
          name: provider.name,
          stale: snapshot.stale,
          imageModels: snapshot.models.map(m => ({
            id: m.id,
            name: m.name,
            ...m.description === undefined ? {} : { description: m.description.slice(0, 300) },
            parameters: Object.fromEntries(Object.entries(m.parameters).map(([k, v]) => [k, describeSpec(v)])),
          })),
        })
      }
      return {
        providers: out,
        defaults: {
          provider: service.settings().defaultImageProvider ?? null,
          imageModel: service.settings().defaultImageModel ?? null,
        },
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: TOOL_GENERATE_IMAGE,
    description: 'Generate images from a text prompt with an image model of a configured provider. '
      + 'The images are saved under the working directory and shown to the user; each call may cost money, '
      + 'so do not call it repeatedly without the user asking. Use media_list_models to find model ids and the '
      + 'aspect_ratio/resolution values a model accepts.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'What to draw. Pass the user\'s wording; do not translate it unless asked.' },
      model: { type: 'string', description: 'Image model id from media_list_models; omit to use the configured default.' },
      provider: { type: 'string', description: 'DSH provider id; needed only when several are configured.' },
      count: { type: 'integer', description: 'Number of images (default 1).' },
      aspect_ratio: { type: 'string', description: 'Aspect ratio such as 1:1 or 16:9, if the model accepts it.' },
      resolution: { type: 'string', description: 'Resolution tier such as 1K or 2K, if the model accepts it.' },
      seed: { type: 'integer', description: 'Seed for reproducible output, if the model accepts it.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderImageResult(value as unknown as ImageToolValue),
    },
    timeoutMs: 600_000,
    async execute(args, exec) {
      const plan = await service.plan(args, exec.signal)
      const cwd = await workingDirectory(ctx, exec)
      const dir = resolveOutputDir(cwd, config.outputDir)
      const result = await service.generate(plan, args.prompt, exec.signal)
      const attachments: AttachmentStore | undefined = ctx.get('attachments')
      const { saved, attachmentFailures } = await saveImages(result.images.map(i => i.data), {
        dir, model: plan.model.id, attachments, maxBytes: config.maxImageBytes,
      })
      const value: ImageToolValue = {
        provider: plan.provider.id,
        model: plan.model.id,
        images: saved.map(s => ({
          path: s.path,
          mediaType: s.mediaType,
          bytes: s.bytes,
          ...s.attachment === undefined ? {} : { attachment: s.attachment as unknown as Record<string, unknown> },
        })),
        costUsd: result.costUsd,
        staleCatalog: plan.staleCatalog,
        attachmentFailures,
      }
      return value as never
    },
  }))
}

/** Canonical value of one image generation. */
export interface ImageToolValue {
  provider: string
  model: string
  images: { path: string; mediaType: string; bytes: number; attachment?: Record<string, unknown> }[]
  costUsd: number | null
  staleCatalog: boolean
  attachmentFailures: number
}

/**
 * Model-facing rendering: a text summary plus each durable image. Text-only
 * routes receive DSH's image placeholders instead of the pixels.
 */
export function renderImageResult(value: ImageToolValue): ContentBlock[] {
  const lines = [
    `Generated ${value.images.length} image(s) with ${value.model} (provider ${value.provider}).`,
    ...value.images.map(i => `- ${i.path} (${i.mediaType}, ${i.bytes} bytes)`),
    `Cost: ${value.costUsd === null ? 'not reported' : `${value.costUsd} USD`}.`,
    'To hand a file to the user as a deliverable, call the present tool with its path.',
  ]
  if (value.attachmentFailures > 0) lines.push(`${value.attachmentFailures} image(s) could not be attached inline; the files are saved.`)
  const blocks: ContentBlock[] = [{ type: 'text', text: lines.join('\n') }]
  for (const image of value.images) {
    if (image.attachment !== undefined) blocks.push({ type: 'image', attachment: image.attachment as unknown as ImageAttachmentRef })
  }
  return blocks
}

