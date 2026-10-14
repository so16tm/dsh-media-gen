/**
 * MediaService: resolves providers and models and runs image generation. Tools
 * and the approval hook share one instance so they share one catalog cache.
 * @module dsh-media-gen/src/service
 */

import { CapabilityCatalog, estimateImageCost, type CatalogSnapshot } from './catalog.ts'
import { MediaError } from './errors.ts'
import { OpenRouterAdapter, validateParams, type ImageModel, type ImageResult } from './openrouter.ts'
import type { MediaProvider, ProviderBridge } from './provider-bridge.ts'

/** Live settings, read again on every use. */
export interface ServiceSettings {
  defaultImageProvider?: string | undefined
  defaultImageModel?: string | undefined
  maxImagesPerCall: number
}

/** Settings fixed for the plugin's lifetime. */
export interface ServiceOptions {
  catalogTtlMs: number
  requestTimeoutMs: number
}

/** Arguments of one image generation. */
export interface ImageArgs {
  prompt: string
  provider?: string | undefined
  model?: string | undefined
  count?: number | undefined
  aspect_ratio?: string | undefined
  resolution?: string | undefined
  seed?: number | undefined
}

/** A fully resolved generation plan, computed before anything is billed. */
export interface ImagePlan {
  provider: MediaProvider
  model: ImageModel
  count: number
  params: Record<string, string | number | boolean>
  /** True when the model listing could not be refreshed. */
  staleCatalog: boolean
}

/** Factory for adapters; replaced in tests. */
export type AdapterFactory = (provider: MediaProvider, apiKey: string, timeoutMs: number) => OpenRouterAdapter

const defaultFactory: AdapterFactory = (provider, apiKey, timeoutMs) =>
  new OpenRouterAdapter({ baseURL: provider.baseURL, apiKey, timeoutMs })

/** Model and provider resolution plus generation. */
export class MediaService {
  readonly catalog: CapabilityCatalog

  constructor(
    readonly bridge: ProviderBridge,
    readonly settings: () => ServiceSettings,
    private readonly options: ServiceOptions,
    private readonly createAdapter: AdapterFactory = defaultFactory,
  ) {
    this.catalog = new CapabilityCatalog(options.catalogTtlMs)
  }

  private async adapter(provider: MediaProvider): Promise<OpenRouterAdapter> {
    return this.createAdapter(provider, await this.bridge.resolveApiKey(provider), this.options.requestTimeoutMs)
  }

  /** List image models of one provider through the cache. */
  async imageModels(provider: MediaProvider, options?: { refresh?: boolean; signal?: AbortSignal }): Promise<CatalogSnapshot> {
    return this.catalog.imageModels(provider.id, async signal => (await this.adapter(provider)).listImageModels(signal), options)
  }

  /**
   * Resolve provider, model, and parameters without spending anything.
   * @throws MediaError for every invalid choice.
   */
  async plan(args: ImageArgs, signal?: AbortSignal): Promise<ImagePlan> {
    if (args.prompt.trim().length === 0) throw new MediaError('INVALID_REQUEST', 'prompt must not be empty')
    const settings = this.settings()
    const count = args.count ?? 1
    if (!Number.isInteger(count) || count < 1) throw new MediaError('INVALID_REQUEST', 'count must be a positive integer')
    if (count > settings.maxImagesPerCall) {
      throw new MediaError('LIMIT_EXCEEDED', `count ${count} exceeds the configured limit of ${settings.maxImagesPerCall} images per call`)
    }
    const modelId = args.model ?? settings.defaultImageModel
    const provider = this.bridge.pick(args.provider ?? (args.model === undefined ? settings.defaultImageProvider : undefined))
    if (modelId === undefined) {
      throw new MediaError('NO_MODEL', 'no image model was given and no default is configured; call media_list_models and pass a model id')
    }
    const snapshot = await this.imageModels(provider, signal === undefined ? {} : { signal })
    const model = snapshot.models.find(m => m.id === modelId)
    if (model === undefined) {
      throw new MediaError('UNSUPPORTED_MODEL', `provider "${provider.id}" lists no image model "${modelId}"; call media_list_models for the available ids`)
    }
    const params = validateParams(model, {
      aspect_ratio: args.aspect_ratio,
      resolution: args.resolution,
      seed: args.seed,
      // `n` is sent only when more than one image is wanted, so single-image
      // models that do not declare it still work.
      n: count > 1 ? count : undefined,
    })
    return { provider, model, count, params, staleCatalog: snapshot.stale }
  }

  /** Estimate the plan's cost in USD; undefined when it cannot be estimated. */
  async estimate(plan: ImagePlan, signal?: AbortSignal): Promise<number | undefined> {
    const lines = await this.catalog.imagePricing(plan.provider.id, plan.model.id,
      async (id, s) => (await this.adapter(plan.provider)).getImagePricing(id, s), signal)
    const resolution = typeof plan.params.resolution === 'string' ? plan.params.resolution : undefined
    return estimateImageCost(lines, plan.count, resolution)
  }

  /** Run one planned generation. Sent once; never retried. */
  async generate(plan: ImagePlan, prompt: string, signal?: AbortSignal): Promise<ImageResult> {
    const adapter = await this.adapter(plan.provider)
    return adapter.generateImage({ model: plan.model.id, prompt, params: plan.params }, signal)
  }
}
