/**
 * MediaService: resolves providers and models and runs image generation and
 * video job submission. Tools, the approval hook, and the job watcher share
 * one instance so they share one catalog cache.
 * @module dsh-media-gen/src/service
 */

import { CapabilityCatalog, estimateImageCost, type CatalogSnapshot } from './catalog.ts'
import { MediaError } from './errors.ts'
import { OpenRouterAdapter, validateParams, type ImageModel, type ImageResult } from './openrouter.ts'
import type { MediaProvider, ProviderBridge } from './provider-bridge.ts'
import { estimateVideoCost, validateVideoParams, type CostRange, type VideoArgs, type VideoJobState, type VideoModel } from './video.ts'

/** Live settings, read again on every use. */
export interface ServiceSettings {
  defaultImageProvider?: string | undefined
  defaultImageModel?: string | undefined
  maxImagesPerCall: number
  defaultVideoProvider?: string | undefined
  defaultVideoModel?: string | undefined
  /** Longest video duration a call may request, in seconds. */
  maxVideoSeconds: number
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

/** A fully resolved video job plan, computed before anything is billed. */
export interface VideoPlan {
  provider: MediaProvider
  model: VideoModel
  params: Record<string, string | number | boolean>
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

  /** List video models of one provider through the cache. */
  async videoModels(provider: MediaProvider, options?: { refresh?: boolean; signal?: AbortSignal }): Promise<CatalogSnapshot<VideoModel>> {
    return this.catalog.videoModels(provider.id, async signal => (await this.adapter(provider)).listVideoModels(signal), options)
  }

  /**
   * Resolve provider, video model, and parameters without spending anything.
   * @throws MediaError for every invalid choice.
   */
  async planVideo(args: VideoArgs, signal?: AbortSignal): Promise<VideoPlan> {
    if (args.prompt.trim().length === 0) throw new MediaError('INVALID_REQUEST', 'prompt must not be empty')
    const settings = this.settings()
    if (args.duration !== undefined && args.duration > settings.maxVideoSeconds) {
      throw new MediaError('LIMIT_EXCEEDED', `duration ${args.duration} s exceeds the configured limit of ${settings.maxVideoSeconds} s`)
    }
    const modelId = args.model ?? settings.defaultVideoModel
    const provider = this.bridge.pick(args.provider ?? (args.model === undefined ? settings.defaultVideoProvider : undefined))
    if (modelId === undefined) {
      throw new MediaError('NO_MODEL', 'no video model was given and no default is configured; call media_list_models with kind "video" and pass a model id')
    }
    const snapshot = await this.videoModels(provider, signal === undefined ? {} : { signal })
    const model = snapshot.models.find(m => m.id === modelId)
    if (model === undefined) {
      throw new MediaError('UNSUPPORTED_MODEL', `provider "${provider.id}" lists no video model "${modelId}"; call media_list_models with kind "video" for the available ids`)
    }
    // Without an explicit duration the provider picks one; refuse when even
    // the shortest duration the model offers is above the limit.
    if (args.duration === undefined && model.durations !== undefined && model.durations.length > 0
      && Math.min(...model.durations) > settings.maxVideoSeconds) {
      throw new MediaError('LIMIT_EXCEEDED', `every duration model "${model.id}" offers exceeds the configured limit of ${settings.maxVideoSeconds} s`)
    }
    return { provider, model, params: validateVideoParams(model, args), staleCatalog: snapshot.stale }
  }

  /** Approximate the plan's cost; undefined when the SKUs cannot be read. */
  estimateVideo(plan: VideoPlan): CostRange | undefined {
    const duration = typeof plan.params.duration === 'number' ? plan.params.duration : undefined
    const resolution = typeof plan.params.resolution === 'string' ? plan.params.resolution : undefined
    return estimateVideoCost(plan.model, duration, resolution)
  }

  /** Submit one planned video job. Sent once; never retried. */
  async submitVideo(plan: VideoPlan, prompt: string, signal?: AbortSignal): Promise<VideoJobState> {
    const adapter = await this.adapter(plan.provider)
    return adapter.submitVideo({ model: plan.model.id, prompt, params: plan.params }, signal)
  }

  /** Read one job's state through the provider it was submitted to. */
  async getVideoJob(providerId: string, jobId: string, signal?: AbortSignal): Promise<VideoJobState> {
    return (await this.adapter(this.bridge.pick(providerId))).getVideoJob(jobId, signal)
  }

  /** Download one output of a completed job. */
  async downloadVideo(providerId: string, jobId: string, index: number, maxBytes: number, signal?: AbortSignal): Promise<{ data: Uint8Array; contentType?: string }> {
    return (await this.adapter(this.bridge.pick(providerId))).downloadVideo(jobId, index, maxBytes, signal)
  }
}
