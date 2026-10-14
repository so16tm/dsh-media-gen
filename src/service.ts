/**
 * MediaService: resolves providers and models and runs image generation and
 * video job submission. Tools, the approval hook, and the job watcher share
 * one instance so they share one catalog cache.
 * @module dsh-media-gen/src/service
 */

import { CapabilityCatalog, estimateImageCost, type CatalogSnapshot } from './catalog.ts'
import { MediaError } from './errors.ts'
import { inputPaths, type InputImage } from './input-images.ts'
import { OpenRouterAdapter, validateParams, type ImageModel, type ImageResult } from './openrouter.ts'
import type { MediaProvider, ProviderBridge } from './provider-bridge.ts'
import {
  estimateVideoCost, validateVideoInputs, validateVideoParams, type CostRange, type VideoArgs, type VideoInputs, type VideoJobState, type VideoModel,
} from './video.ts'

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
  /** Reference images: paths in the working directory. */
  input_images?: string[] | undefined
  /** Prompts of further images that differ from the first, one complete prompt each. */
  variations?: string[] | undefined
}

/**
 * A prompt that asks for several different images at once, which `count`
 * turns into copies of one collage. English and Japanese wording.
 */
const VARIANT_LIST = /\b(?:different|various|varied|several|multiple|three|four|five)\s+(?:poses?|angles?|styles?|outfits?|expressions?|scenes?|views?|actions?|positions?)\b|\bcollage\b|\bgrid of\b|\b[2-9]\s?x\s?[2-9]\b|(?:^|\s)[1-9][).]\s|(?:違う|異なる|別々の|いろいろな|様々な|さまざまな)(?:\s|の)*(?:ポーズ|角度|アングル|表情|服装|衣装|シーン|場面|構図|スタイル|動き|姿勢)|コラージュ|[2-9２-９]\s*(?:枚|コマ)の?(?:画像|写真|イラスト|絵|カット)/iu

/** A fully resolved generation plan, computed before anything is billed. */
export interface ImagePlan {
  provider: MediaProvider
  model: ImageModel
  count: number
  params: Record<string, string | number | boolean>
  /** Reference image paths, read when the plan runs. */
  inputs: string[]
  /** Prompts of further images, generated after the first prompt's. */
  variations: string[]
  /** True when the model listing could not be refreshed. */
  staleCatalog: boolean
}

/** A fully resolved video job plan, computed before anything is billed. */
export interface VideoPlan {
  provider: MediaProvider
  model: VideoModel
  params: Record<string, string | number | boolean>
  /** Input image paths, read when the job is submitted. */
  inputs: VideoInputs
  staleCatalog: boolean
}

/** A video's input images once read. */
export interface LoadedVideoInputs {
  first?: InputImage
  last?: InputImage
  references: InputImage[]
}

/** Number of input images a video sends. */
export function videoInputCount(inputs: VideoInputs): number {
  return (inputs.first === undefined ? 0 : 1) + (inputs.last === undefined ? 0 : 1) + inputs.references.length
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
    const variations = (args.variations ?? []).map(v => v.trim()).filter(v => v.length > 0)
    if (variations.length > 0 && count > 1) {
      throw new MediaError('INVALID_REQUEST', 'use either count (copies of one prompt) or variations (one prompt per differing image), not both')
    }
    if (count * (1 + variations.length) > settings.maxImagesPerCall) {
      throw new MediaError('LIMIT_EXCEEDED', `${1 + variations.length} images exceed the configured limit of ${settings.maxImagesPerCall} images per call`)
    }
    // A prompt that lists several images yields one collage per request, so every prompt must describe one image.
    const listing = [args.prompt, ...variations].findIndex(p => VARIANT_LIST.test(p))
    if (listing >= 0 && (count > 1 || variations.length > 0)) {
      throw new MediaError('INVALID_REQUEST', `prompt ${listing + 1} describes several different images, and each request `
        + 'then returns one collage. Nothing was generated. Send one prompt per image instead: each describes exactly one '
        + 'image (one pose, angle, or scene) and never mentions the others or how many there are, so N images means N '
        + 'prompts. Do not add images beyond what the user asked for.')
    }
    const inputs = inputPaths(args.input_images, 'input_images')
    if (inputs.length > 0) {
      if (model.inputModalities.length > 0 && !model.inputModalities.includes('image')) {
        throw new MediaError('UNSUPPORTED_PARAMETER', `model "${model.id}" does not take input images`)
      }
      const limit = model.parameters.input_references
      if (limit?.kind === 'range' && limit.max !== undefined && inputs.length > limit.max) {
        throw new MediaError('UNSUPPORTED_PARAMETER', limit.max === 0
          ? `model "${model.id}" does not take input images`
          : `model "${model.id}" takes at most ${limit.max} input images; got ${inputs.length}`)
      }
    }
    return { provider, model, count, params, inputs, variations, staleCatalog: snapshot.stale }
  }

  /** Estimate the plan's cost in USD; undefined when it cannot be estimated. */
  async estimate(plan: ImagePlan, signal?: AbortSignal): Promise<number | undefined> {
    const lines = await this.catalog.imagePricing(plan.provider.id, plan.model.id,
      async (id, s) => (await this.adapter(plan.provider)).getImagePricing(id, s), signal)
    const resolution = typeof plan.params.resolution === 'string' ? plan.params.resolution : undefined
    return estimateImageCost(lines, plan.count * (1 + plan.variations.length), resolution)
  }

  /** Run one planned generation. Sent once; never retried. */
  async generate(plan: ImagePlan, prompt: string, signal?: AbortSignal, inputs: readonly InputImage[] = []): Promise<ImageResult> {
    const adapter = await this.adapter(plan.provider)
    return adapter.generateImage({
      model: plan.model.id, prompt, params: plan.params, ...inputs.length === 0 ? {} : { inputReferences: inputs.map(i => i.dataUrl) },
    }, signal)
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
    // When the model could pick a length above the limit, ask for the longest one within it.
    const offered = model.durations ?? []
    const within = offered.filter(d => d <= settings.maxVideoSeconds)
    const capped = args.duration === undefined && within.length > 0 && within.length < offered.length
      ? { ...args, duration: Math.max(...within) }
      : args
    const inputs = validateVideoInputs(model, capped, inputPaths(capped.reference_images, 'reference_images'))
    return { provider, model, params: validateVideoParams(model, capped), inputs, staleCatalog: snapshot.stale }
  }

  /** Approximate the plan's cost; undefined when the SKUs cannot be read. */
  estimateVideo(plan: VideoPlan): CostRange | undefined {
    const duration = typeof plan.params.duration === 'number' ? plan.params.duration : undefined
    const resolution = typeof plan.params.resolution === 'string' ? plan.params.resolution : undefined
    return estimateVideoCost(plan.model, duration, resolution, videoInputCount(plan.inputs))
  }

  /** Submit one planned video job. Sent once; never retried. */
  async submitVideo(plan: VideoPlan, prompt: string, signal?: AbortSignal, inputs?: LoadedVideoInputs): Promise<VideoJobState> {
    const adapter = await this.adapter(plan.provider)
    const frames = [
      ...inputs?.first === undefined ? [] : [{ url: inputs.first.dataUrl, frameType: 'first_frame' as const }],
      ...inputs?.last === undefined ? [] : [{ url: inputs.last.dataUrl, frameType: 'last_frame' as const }],
    ]
    const references = (inputs?.references ?? []).map(i => i.dataUrl)
    return adapter.submitVideo({
      model: plan.model.id, prompt, params: plan.params,
      ...frames.length === 0 ? {} : { frameImages: frames },
      ...references.length === 0 ? {} : { inputReferences: references },
    }, signal)
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
