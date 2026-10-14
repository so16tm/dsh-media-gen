/**
 * VideoModels: parsing and validation for OpenRouter's asynchronous Video
 * API. Capabilities and prices come from `GET /videos/models`; nothing about
 * a particular model is hard-coded.
 * @module dsh-media-gen/src/video
 */

import { MediaError } from './errors.ts'

/** Normalized video model capability. Absent lists mean the listing said nothing. */
export interface VideoModel {
  id: string
  name: string
  description?: string
  resolutions?: readonly string[]
  aspectRatios?: readonly string[]
  sizes?: readonly string[]
  durations?: readonly number[]
  /** Whether audio can be generated; undefined when the listing does not say. */
  audio?: boolean
  /** Whether a seed is honored; undefined when the listing does not say. */
  seed?: boolean
  /** Frames an image can fix (`first_frame`, `last_frame`); undefined when the listing does not say. */
  frameImages?: readonly string[]
  /** Price per SKU in USD, with provider-specific SKU names. */
  pricingSkus: Readonly<Record<string, number>>
}

/** Video job request after validation. */
export interface VideoRequest {
  model: string
  prompt: string
  params: Readonly<Record<string, string | number | boolean>>
  /** Images fixing the first or last frame, as data or HTTP(S) URLs. */
  frameImages?: readonly { url: string; frameType: 'first_frame' | 'last_frame' }[]
  /** Reference images guiding the video, as data or HTTP(S) URLs. */
  inputReferences?: readonly string[]
}

/** Provider job states; the last four are terminal. */
export type VideoJobStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'expired'

const STATUSES: ReadonlySet<string> = new Set(['pending', 'in_progress', 'completed', 'failed', 'cancelled', 'expired'])

/** True once the provider will not change the job any more. */
export function isTerminal(status: VideoJobStatus): boolean {
  return status !== 'pending' && status !== 'in_progress'
}

/** One observation of a provider job. */
export interface VideoJobState {
  id: string
  status: VideoJobStatus
  error?: string
  /** Number of downloadable outputs, from `unsigned_urls`. */
  outputs: number
  /** Actual charge in USD, once reported. */
  costUsd?: number
}

/** Arguments of one video generation. */
export interface VideoArgs {
  prompt: string
  provider?: string | undefined
  model?: string | undefined
  duration?: number | undefined
  resolution?: string | undefined
  aspect_ratio?: string | undefined
  generate_audio?: boolean | undefined
  seed?: number | undefined
  /** Image fixing the first frame: a path in the working directory. */
  first_frame?: string | undefined
  /** Image fixing the last frame. */
  last_frame?: string | undefined
  /** Images guiding the look without fixing a frame. */
  reference_images?: string[] | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined
}

function numberList(value: unknown): number[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)) : undefined
}

function flag(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/** SKU names whose price is in US cents. */
const CENTS_SKU = /(?:^|_)cents?(?:_|$)/u

/** Parse `pricing_skus`, whose values are decimal strings; unparsable entries are dropped. */
export function parsePricingSkus(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (!isRecord(raw)) return out
  for (const [sku, value] of Object.entries(raw)) {
    const price = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
    // Some SKUs are priced in cents (`cents_per_video_output_second_480p`); the rest are in USD.
    if (Number.isFinite(price) && price >= 0) out[sku] = CENTS_SKU.test(sku.toLowerCase()) ? price / 100 : price
  }
  return out
}

/**
 * Normalize the `GET /videos/models` body.
 * @param body - parsed JSON.
 * @returns models with an id; malformed entries are skipped.
 */
export function parseVideoModels(body: unknown): VideoModel[] {
  const data = isRecord(body) && Array.isArray(body.data) ? body.data : []
  const out: VideoModel[] = []
  for (const entry of data) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || entry.id.length === 0) continue
    const resolutions = stringList(entry.supported_resolutions)
    const aspectRatios = stringList(entry.supported_aspect_ratios)
    const sizes = stringList(entry.supported_sizes)
    const durations = numberList(entry.supported_durations)
    const audio = flag(entry.generate_audio)
    const seed = flag(entry.seed)
    const frameImages = stringList(entry.supported_frame_images)
    out.push({
      id: entry.id,
      name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : entry.id,
      ...typeof entry.description === 'string' ? { description: entry.description } : {},
      ...resolutions === undefined ? {} : { resolutions },
      ...aspectRatios === undefined ? {} : { aspectRatios },
      ...sizes === undefined ? {} : { sizes },
      ...durations === undefined ? {} : { durations },
      ...audio === undefined ? {} : { audio },
      ...seed === undefined ? {} : { seed },
      ...frameImages === undefined ? {} : { frameImages },
      pricingSkus: parsePricingSkus(entry.pricing_skus),
    })
  }
  return out
}

/**
 * Normalize a job body from `POST /videos` or `GET /videos/{id}`.
 * @returns the state, or undefined when the body names no job.
 */
export function parseVideoJob(body: unknown): VideoJobState | undefined {
  if (!isRecord(body) || typeof body.id !== 'string' || body.id.length === 0) return undefined
  const status = typeof body.status === 'string' && STATUSES.has(body.status) ? body.status as VideoJobStatus : 'pending'
  const usage = isRecord(body.usage) ? body.usage : {}
  const cost = typeof usage.cost === 'number' && Number.isFinite(usage.cost) ? usage.cost : undefined
  const urls = Array.isArray(body.unsigned_urls) ? body.unsigned_urls.length : 0
  return {
    id: body.id,
    status,
    ...typeof body.error === 'string' && body.error.length > 0 ? { error: body.error.slice(0, 500) } : {},
    // A completed job without a listed URL still has its first output.
    outputs: status === 'completed' ? Math.max(urls, 1) : urls,
    ...cost === undefined ? {} : { costUsd: cost },
  }
}

function pick(model: VideoModel, name: string, value: string, allowed: readonly string[] | undefined): string {
  if (allowed === undefined || allowed.length === 0) return value
  const found = allowed.find(v => v.toLowerCase() === value.toLowerCase())
  if (found === undefined) {
    throw new MediaError('UNSUPPORTED_PARAMETER', `model "${model.id}" accepts ${name} values ${allowed.join(', ')}; got ${value}`)
  }
  return found
}

/**
 * Validate optional parameters against a video model's listing. A list the
 * listing leaves empty is not enforced; the provider then decides.
 * @returns the parameters to send.
 * @throws MediaError UNSUPPORTED_PARAMETER for a value the model does not accept.
 */
export function validateVideoParams(model: VideoModel, args: VideoArgs): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  if (args.resolution !== undefined) out.resolution = pick(model, 'resolution', args.resolution, model.resolutions)
  if (args.aspect_ratio !== undefined) out.aspect_ratio = pick(model, 'aspect_ratio', args.aspect_ratio, model.aspectRatios)
  if (args.duration !== undefined) {
    if (!Number.isInteger(args.duration) || args.duration < 1) throw new MediaError('INVALID_REQUEST', 'duration must be a positive whole number of seconds')
    if (model.durations !== undefined && model.durations.length > 0 && !model.durations.includes(args.duration)) {
      throw new MediaError('UNSUPPORTED_PARAMETER', `model "${model.id}" accepts duration values ${model.durations.join(', ')}; got ${args.duration}`)
    }
    out.duration = args.duration
  }
  if (args.generate_audio !== undefined) {
    if (args.generate_audio && model.audio === false) throw new MediaError('UNSUPPORTED_PARAMETER', `model "${model.id}" cannot generate audio`)
    out.generate_audio = args.generate_audio
  }
  if (args.seed !== undefined) {
    if (model.seed === false) throw new MediaError('UNSUPPORTED_PARAMETER', `model "${model.id}" does not support seed`)
    out.seed = args.seed
  }
  return out
}

/** The input images of one video, checked against the model before anything is read. */
export interface VideoInputs {
  first?: string
  last?: string
  references: string[]
}

/**
 * Check a video's input images against the listing. A model whose listing
 * names no frame support is refused frames; one that says nothing is let
 * through and the provider decides.
 * @throws MediaError UNSUPPORTED_PARAMETER for a frame the model cannot take.
 */
export function validateVideoInputs(model: VideoModel, args: VideoArgs, references: string[]): VideoInputs {
  const first = args.first_frame?.trim() || undefined
  const last = args.last_frame?.trim() || undefined
  for (const [frame, value] of [['first_frame', first], ['last_frame', last]] as const) {
    if (value !== undefined && model.frameImages !== undefined && !model.frameImages.includes(frame)) {
      throw new MediaError('UNSUPPORTED_PARAMETER', model.frameImages.length === 0
        ? `model "${model.id}" does not take input images as frames`
        : `model "${model.id}" takes ${model.frameImages.join(', ')} images; not ${frame}`)
    }
  }
  return { ...first === undefined ? {} : { first }, ...last === undefined ? {} : { last }, references }
}

/** Approximate price of one job; a range when the SKUs leave the tier open. */
export interface CostRange {
  min: number
  max: number
}

const RESOLUTION_TOKEN = /(?:^|[^a-z0-9])(360p|480p|720p|768p|1080p|1k|2k|4k)(?:$|[^a-z0-9])/u

/**
 * Estimate a job's price from `pricing_skus`. SKU names are provider
 * specific, so only two shapes are recognized: per-second SKUs (the name
 * mentions seconds) multiplied by the duration, and flat per-video SKUs. A
 * SKU naming a resolution counts only when it matches the requested one.
 * Anything else yields undefined rather than a guess.
 * @param model - the model listing.
 * @param duration - requested seconds; when absent, the model's duration range is used.
 * @param resolution - requested resolution, if any.
 * @param inputImages - input images sent, billed by models with a per-image SKU.
 */
export function estimateVideoCost(model: VideoModel, duration?: number, resolution?: string, inputImages = 0): CostRange | undefined {
  const wanted = resolution?.toLowerCase()
  const perSecond: number[] = []
  const perVideo: number[] = []
  let perInput = 0
  for (const [sku, price] of Object.entries(model.pricingSkus)) {
    const name = sku.toLowerCase()
    // An SKU billed per input image adds to every shape below.
    if (/input_?image|image_?input|reference_?image/u.test(name)) {
      perInput = Math.max(perInput, price)
      continue
    }
    const tier = RESOLUTION_TOKEN.exec(name)?.[1]
    if (tier !== undefined && wanted !== undefined && tier !== wanted) continue
    if (/sec(?:ond)?s?(?![a-z])|per_s(?![a-z])/u.test(name)) perSecond.push(price)
    else if (/generat|video|request|clip|output/u.test(name)) perVideo.push(price)
  }
  const inputs = perInput * inputImages
  if (perSecond.length > 0) {
    const seconds = duration !== undefined ? [duration] : model.durations ?? []
    if (seconds.length === 0) return undefined
    return {
      min: Math.min(...perSecond) * Math.min(...seconds) + inputs,
      max: Math.max(...perSecond) * Math.max(...seconds) + inputs,
    }
  }
  if (perVideo.length > 0) return { min: Math.min(...perVideo) + inputs, max: Math.max(...perVideo) + inputs }
  return undefined
}

/** Identify a supported video container from its signature. */
export function sniffVideo(data: Uint8Array): { mediaType: string; extension: string } | undefined {
  const ascii = (offset: number, text: string) => [...text].every((c, i) => data[offset + i] === c.charCodeAt(0))
  if (ascii(4, 'ftyp')) return ascii(8, 'qt  ') ? { mediaType: 'video/quicktime', extension: 'mov' } : { mediaType: 'video/mp4', extension: 'mp4' }
  if (data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3) return { mediaType: 'video/webm', extension: 'webm' }
  if (ascii(0, 'GIF8')) return { mediaType: 'image/gif', extension: 'gif' }
  return undefined
}
