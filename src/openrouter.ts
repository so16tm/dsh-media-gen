/**
 * OpenRouterAdapter: HTTP calls to OpenRouter's Image and Video APIs. Model ids
 * are never hard-coded; every capability comes from the model listings.
 * @module dsh-media-gen/src/openrouter
 */

import { classifyHttpError, MediaError, redact } from './errors.ts'
import { parseVideoJob, parseVideoModels, type VideoJobState, type VideoModel, type VideoRequest } from './video.ts'

/** How one request parameter is constrained by a model. */
export type ParameterSpec =
  | { kind: 'enum'; values: readonly (string | number)[] }
  | { kind: 'range'; min?: number; max?: number }
  | { kind: 'boolean' }
  | { kind: 'any' }

/** One price line from a model's endpoint listing. */
export interface ImagePrice {
  /** What is billed, e.g. `output_image`. */
  billable: string
  /** Billing unit, e.g. `image`, `megapixel`, `token`. */
  unit: string
  /** Price in USD per unit. */
  costUsd: number
  /** Optional variant such as a resolution tier (`2k`). */
  variant?: string
}

/** Normalized image model capability. */
export interface ImageModel {
  id: string
  name: string
  description?: string
  inputModalities: readonly string[]
  outputModalities: readonly string[]
  /** Supported request parameters keyed by wire name. */
  parameters: Readonly<Record<string, ParameterSpec>>
}

/** Image generation request after validation. */
export interface ImageRequest {
  model: string
  prompt: string
  /** Optional parameters; only those the model supports are sent. */
  params: Readonly<Record<string, string | number | boolean>>
  /** Reference images as data or HTTP(S) URLs, sent as `input_references`. */
  inputReferences?: readonly string[]
}

/** Content parts of `input_references`. */
export function imageParts(urls: readonly string[]): { type: 'image_url'; image_url: { url: string } }[] {
  return urls.map(url => ({ type: 'image_url', image_url: { url } }))
}

/** One generated image. */
export interface GeneratedImage {
  data: Uint8Array
  /** Media type reported by the provider, if any. */
  mediaType?: string
}

/** Image generation outcome. */
export interface ImageResult {
  images: GeneratedImage[]
  /** Actual charge in USD reported by OpenRouter; null when not reported. */
  costUsd: number | null
}

/** Connection and transport options for one adapter instance. */
export interface OpenRouterOptions {
  baseURL: string
  apiKey: string
  fetch?: typeof fetch
  /** Per-request timeout in milliseconds. */
  timeoutMs: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/**
 * Normalize one `supported_parameters` entry. The listing expresses each
 * parameter as an enum, a numeric range, or a flag; unknown shapes are kept
 * as `any` so a supported parameter is never silently dropped.
 */
export function parseParameterSpec(raw: unknown): ParameterSpec | undefined {
  if (raw === false || raw === null || raw === undefined) return undefined
  if (raw === true) return { kind: 'boolean' }
  if (Array.isArray(raw)) {
    const values = raw.filter((v): v is string | number => typeof v === 'string' || typeof v === 'number')
    return values.length > 0 ? { kind: 'enum', values } : { kind: 'any' }
  }
  if (isRecord(raw)) {
    const values = raw.enum ?? raw.values ?? raw.options
    if (Array.isArray(values)) return parseParameterSpec(values)
    if (raw.type === 'boolean') return { kind: 'boolean' }
    const min = typeof raw.min === 'number' ? raw.min : typeof raw.minimum === 'number' ? raw.minimum : undefined
    const max = typeof raw.max === 'number' ? raw.max : typeof raw.maximum === 'number' ? raw.maximum : undefined
    if (min !== undefined || max !== undefined) {
      return { kind: 'range', ...min === undefined ? {} : { min }, ...max === undefined ? {} : { max } }
    }
  }
  return { kind: 'any' }
}

/** Parse the `supported_parameters` field, which may be a map or a name list. */
function parseParameters(raw: unknown): Record<string, ParameterSpec> {
  const out: Record<string, ParameterSpec> = {}
  if (Array.isArray(raw)) {
    for (const name of strings(raw)) out[name] = { kind: 'any' }
    return out
  }
  if (!isRecord(raw)) return out
  for (const [name, value] of Object.entries(raw)) {
    const spec = parseParameterSpec(value)
    if (spec !== undefined) out[name] = spec
  }
  return out
}

/**
 * Normalize the `GET /images/models` body.
 * @param body - parsed JSON.
 * @returns models with an id; malformed entries are skipped.
 */
export function parseImageModels(body: unknown): ImageModel[] {
  const data = isRecord(body) && Array.isArray(body.data) ? body.data : []
  const out: ImageModel[] = []
  for (const entry of data) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || entry.id.length === 0) continue
    const arch = isRecord(entry.architecture) ? entry.architecture : {}
    out.push({
      id: entry.id,
      name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : entry.id,
      ...typeof entry.description === 'string' ? { description: entry.description } : {},
      inputModalities: strings(arch.input_modalities),
      outputModalities: strings(arch.output_modalities),
      parameters: parseParameters(entry.supported_parameters),
    })
  }
  return out
}

/**
 * Normalize the pricing lines of `GET /images/models/{id}/endpoints`. Every
 * endpoint's `pricing` array is collected; numeric strings are accepted.
 */
export function parseImagePricing(body: unknown): ImagePrice[] {
  const root = isRecord(body) && isRecord(body.data) ? body.data : body
  const endpoints = isRecord(root) && Array.isArray(root.endpoints) ? root.endpoints : Array.isArray(root) ? root : []
  const out: ImagePrice[] = []
  for (const endpoint of endpoints) {
    if (!isRecord(endpoint) || !Array.isArray(endpoint.pricing)) continue
    for (const line of endpoint.pricing) {
      if (!isRecord(line) || typeof line.billable !== 'string' || typeof line.unit !== 'string') continue
      const cost = typeof line.cost_usd === 'number' ? line.cost_usd : Number(line.cost_usd)
      if (!Number.isFinite(cost)) continue
      out.push({
        billable: line.billable,
        unit: line.unit,
        costUsd: cost,
        ...typeof line.variant === 'string' ? { variant: line.variant } : {},
      })
    }
  }
  return out
}

/**
 * Validate optional parameters against a model's declared capability.
 * @returns the parameters to send.
 * @throws MediaError UNSUPPORTED_PARAMETER for an undeclared or out-of-range value.
 */
export function validateParams(
  model: ImageModel,
  params: Readonly<Record<string, string | number | boolean | undefined>>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined) continue
    const spec = model.parameters[name]
    if (spec === undefined) {
      throw new MediaError('UNSUPPORTED_PARAMETER', `model "${model.id}" does not support ${name}; supported: ${Object.keys(model.parameters).join(', ') || 'none'}`)
    }
    if (spec.kind === 'enum' && !spec.values.some(v => String(v).toLowerCase() === String(value).toLowerCase())) {
      throw new MediaError('UNSUPPORTED_PARAMETER', `model "${model.id}" accepts ${name} values ${spec.values.join(', ')}; got ${String(value)}`)
    }
    if (spec.kind === 'range' && typeof value === 'number'
      && ((spec.min !== undefined && value < spec.min) || (spec.max !== undefined && value > spec.max))) {
      throw new MediaError('UNSUPPORTED_PARAMETER', `model "${model.id}" accepts ${name} from ${spec.min ?? '-'} to ${spec.max ?? '-'}; got ${value}`)
    }
    out[name] = spec.kind === 'enum'
      ? spec.values.find(v => String(v).toLowerCase() === String(value).toLowerCase()) ?? value
      : value
  }
  return out
}

/** Thin client over OpenRouter's Image API. */
export class OpenRouterAdapter {
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: OpenRouterOptions) {
    this.fetchImpl = options.fetch ?? fetch
  }

  /** List image models with their supported parameters. */
  async listImageModels(signal?: AbortSignal): Promise<ImageModel[]> {
    return parseImageModels(await this.request('GET', '/images/models', undefined, signal))
  }

  /** Read one model's per-endpoint pricing lines. */
  async getImagePricing(modelId: string, signal?: AbortSignal): Promise<ImagePrice[]> {
    const path = `/images/models/${modelId.split('/').map(encodeURIComponent).join('/')}/endpoints`
    return parseImagePricing(await this.request('GET', path, undefined, signal))
  }

  /**
   * Generate images synchronously. The request is sent once: a POST that may
   * already be billed is never retried automatically.
   */
  async generateImage(request: ImageRequest, signal?: AbortSignal): Promise<ImageResult> {
    const body = await this.request('POST', '/images', {
      model: request.model, prompt: request.prompt, ...request.params,
      ...request.inputReferences === undefined || request.inputReferences.length === 0 ? {} : { input_references: imageParts(request.inputReferences) },
    }, signal)
    if (!isRecord(body) || !Array.isArray(body.data)) {
      throw new MediaError('INVALID_RESPONSE', 'the provider returned no image data')
    }
    const images: GeneratedImage[] = []
    for (const item of body.data) {
      if (!isRecord(item) || typeof item.b64_json !== 'string') continue
      const data = decodeBase64(item.b64_json)
      if (data.byteLength === 0) continue
      images.push({ data, ...typeof item.media_type === 'string' ? { mediaType: item.media_type } : {} })
    }
    if (images.length === 0) throw new MediaError('INVALID_RESPONSE', 'the provider returned no decodable image')
    const usage = isRecord(body.usage) ? body.usage : {}
    const cost = typeof usage.cost === 'number' && Number.isFinite(usage.cost) ? usage.cost : null
    return { images, costUsd: cost }
  }

  /** List video models with their supported options and pricing SKUs. */
  async listVideoModels(signal?: AbortSignal): Promise<VideoModel[]> {
    return parseVideoModels(await this.request('GET', '/videos/models', undefined, signal))
  }

  /**
   * Submit one video job. Sent once: a POST that may already be billed is
   * never retried automatically.
   */
  async submitVideo(request: VideoRequest, signal?: AbortSignal): Promise<VideoJobState> {
    const frames = request.frameImages ?? []
    const references = request.inputReferences ?? []
    const body = await this.request('POST', '/videos', {
      model: request.model, prompt: request.prompt, ...request.params,
      ...frames.length === 0 ? {} : {
        frame_images: frames.map(f => ({ type: 'image_url', image_url: { url: f.url }, frame_type: f.frameType })),
      },
      ...references.length === 0 ? {} : { input_references: imageParts(references) },
    }, signal)
    const state = parseVideoJob(body)
    if (state === undefined) throw new MediaError('INVALID_RESPONSE', 'the provider accepted the video request but returned no job id')
    return state
  }

  /** Read the current state of one video job. */
  async getVideoJob(jobId: string, signal?: AbortSignal): Promise<VideoJobState> {
    const state = parseVideoJob(await this.request('GET', `/videos/${encodeURIComponent(jobId)}`, undefined, signal))
    if (state === undefined) throw new MediaError('INVALID_RESPONSE', 'the provider returned no video job state')
    return state
  }

  /**
   * Download one output of a completed job. The content URL is not presigned,
   * so it is fetched with the same credential as the API.
   * @param maxBytes - largest accepted body.
   */
  async downloadVideo(jobId: string, index: number, maxBytes: number, signal?: AbortSignal): Promise<{ data: Uint8Array; contentType?: string }> {
    const response = await this.send('GET', `/videos/${encodeURIComponent(jobId)}/content?index=${index}`, undefined, signal, '*/*')
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel()
      throw new MediaError('INVALID_RESPONSE', `the video is ${declared} bytes, above the ${maxBytes}-byte limit`)
    }
    const data = new Uint8Array(await response.arrayBuffer())
    if (data.byteLength > maxBytes) throw new MediaError('INVALID_RESPONSE', `the video is ${data.byteLength} bytes, above the ${maxBytes}-byte limit`)
    const contentType = response.headers.get('content-type')
    return { data, ...contentType === null ? {} : { contentType } }
  }

  private async request(method: 'GET' | 'POST', path: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await this.send(method, path, payload, signal, 'application/json')
    const text = await response.text()
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new MediaError('INVALID_RESPONSE', 'the provider returned a non-JSON response')
    }
  }

  /** Send one request and classify transport and HTTP failures; the caller reads the body. */
  private async send(method: 'GET' | 'POST', path: string, payload: unknown, signal: AbortSignal | undefined, accept: string): Promise<Response> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    let response: Response
    try {
      response = await this.fetchImpl(`${this.options.baseURL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          Accept: accept,
          ...payload === undefined ? {} : { 'Content-Type': 'application/json' },
        },
        ...payload === undefined ? {} : { body: JSON.stringify(payload) },
        signal: combined,
      })
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      if (timeout.aborted) throw new MediaError('TIMEOUT', `the provider did not answer within ${this.options.timeoutMs} ms`, { cause: error })
      throw new MediaError('PROVIDER_ERROR', `could not reach the provider: ${redact(String(error), [this.options.apiKey])}`, { cause: error })
    }
    if (!response.ok) throw classifyHttpError(response.status, redact(errorDetail(await response.text()), [this.options.apiKey]))
    return response
  }
}

/** Extract a short provider message from an error body. */
function errorDetail(text: string): string {
  try {
    const body = JSON.parse(text) as unknown
    if (isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string') return body.error.message.slice(0, 500)
  } catch {
    // Non-JSON bodies fall through to the raw prefix.
  }
  return text.slice(0, 200)
}

/** Decode standard or data-URL Base64; invalid input yields an empty array. */
export function decodeBase64(value: string): Uint8Array {
  const raw = value.startsWith('data:') ? value.slice(value.indexOf(',') + 1) : value
  if (!/^[A-Za-z0-9+/=\s_-]*$/u.test(raw)) return new Uint8Array()
  return new Uint8Array(Buffer.from(raw, 'base64'))
}
