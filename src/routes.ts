/**
 * Routes: authenticated HTTP endpoints the browser half reads model lists and
 * session choices from. They run behind DSH's connection fence, so API keys
 * stay on the Host.
 * @module dsh-media-gen/src/routes
 */

import { createReadStream } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, normalize, sep } from 'node:path'
import { Readable } from 'node:stream'
import { MediaError } from './errors.ts'
import type { VideoJobWatcher } from './jobs.ts'
import type { MediaFileIndex } from './media-files.ts'
import type { ImageModel, ParameterSpec } from './openrouter.ts'
import { sniffImage } from './output.ts'
import type { MediaService } from './service.ts'
import { withSessionModel, type SessionModelStore } from './session-models.ts'
import type { VideoModel } from './video.ts'

/** Model listing route. Query: `kind=image|video`, optional `refresh=1`. */
export const MODELS_PATH = '/api/media-gen.models'

/** Session choice route. Query: `sessionId`. */
export const SESSION_PATH = '/api/media-gen.session'

/**
 * Cost estimate route for the browser's generation card. Query: `kind`,
 * optional `sessionId`, `model`, `provider`, `aspect`, `resolution`,
 * `count`, `duration`, `audio=on|off`, and input image paths (`image`,
 * repeatable, for images; `first`, `last` for videos), which are checked
 * against the model but not read. Nothing is billed.
 */
export const ESTIMATE_PATH = '/api/media-gen.estimate'

/** Generated file route for the chat's media views. Query: `path`. Honors `Range`. */
export const FILE_PATH = '/api/media-gen.file'

/** Video job route for the chat's media views. Query: `id`. */
export const JOB_PATH = '/api/media-gen.job'

/** Values a picker can offer for one model; absent lists are free-form or unsupported. */
export interface ModelOptions {
  aspectRatios?: string[]
  resolutions?: string[]
  durations?: number[]
  /** Whether audio can be switched; undefined when the listing does not say. */
  audio?: boolean
  /** Whether an image model takes input images; undefined when the listing does not say. */
  imageInput?: boolean
  /** Frames a video model takes as images (`first_frame`, `last_frame`). */
  frameImages?: string[]
}

function enumValues(spec: ParameterSpec | undefined): string[] | undefined {
  return spec?.kind === 'enum' ? spec.values.map(String) : undefined
}

/** Picker values of an image model, from its parameter listing. */
export function imageOptions(model: ImageModel): ModelOptions {
  const aspectRatios = enumValues(model.parameters.aspect_ratio)
  const resolutions = enumValues(model.parameters.resolution)
  const references = model.parameters.input_references
  const imageInput = references?.kind === 'range' && references.max === 0 ? false
    : model.inputModalities.length > 0 ? model.inputModalities.includes('image') : undefined
  return {
    ...aspectRatios === undefined ? {} : { aspectRatios },
    ...resolutions === undefined ? {} : { resolutions },
    ...imageInput === undefined ? {} : { imageInput },
  }
}

/** Picker values of a video model. */
export function videoOptions(model: VideoModel): ModelOptions {
  return {
    ...model.aspectRatios === undefined || model.aspectRatios.length === 0 ? {} : { aspectRatios: [...model.aspectRatios] },
    ...model.resolutions === undefined || model.resolutions.length === 0 ? {} : { resolutions: [...model.resolutions] },
    ...model.durations === undefined || model.durations.length === 0 ? {} : { durations: [...model.durations] },
    ...model.audio === undefined ? {} : { audio: model.audio },
    ...model.frameImages === undefined ? {} : { frameImages: [...model.frameImages] },
  }
}

/** The part of DSH's connection fetch registry this plugin uses. */
export interface FetchRegistry {
  register(route: {
    path: string
    methods: ('GET' | 'HEAD' | 'POST')[]
    requestBody: 'buffered' | 'streaming'
    fetch(request: Request): Promise<Response>
  }): () => Promise<void>
}

const NO_STORE = { 'cache-control': 'no-store' }

function failure(status: number, message: string): Response {
  return Response.json({ error: message }, { status, headers: NO_STORE })
}

/**
 * List one kind's models for every media-capable provider.
 * @param service - provider resolution and cached listings.
 * @param request - incoming request.
 */
export async function handleModels(service: MediaService, request: Request): Promise<Response> {
  const url = new URL(request.url)
  const kind = url.searchParams.get('kind')
  if (kind !== 'image' && kind !== 'video') return failure(400, 'kind must be image or video')
  const options = { refresh: url.searchParams.get('refresh') === '1', signal: request.signal }
  const providers = []
  let lastError: string | undefined
  // One provider that cannot list models must not hide the others.
  for (const provider of service.bridge.listProviders()) {
    try {
      const models = kind === 'image'
        ? await service.imageModels(provider, options).then(snapshot => ({
          stale: snapshot.stale, models: snapshot.models.map(model => ({ id: model.id, name: model.name, options: imageOptions(model) })),
        }))
        : await service.videoModels(provider, options).then(snapshot => ({
          stale: snapshot.stale, models: snapshot.models.map(model => ({ id: model.id, name: model.name, options: videoOptions(model) })),
        }))
      providers.push({ id: provider.id, name: provider.name, ...models })
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  if (providers.length === 0 && lastError !== undefined) return failure(502, lastError)
  const settings = service.settings()
  return Response.json({
    kind,
    providers,
    default: kind === 'image' ? settings.defaultImageModel ?? null : settings.defaultVideoModel ?? null,
  }, { headers: NO_STORE })
}

/** Model ids the chat input offers per kind; an empty list offers every listed model. */
export interface ChatModels {
  image: readonly string[]
  video: readonly string[]
}

/**
 * Report one session's choices and the configured defaults.
 * @param store - session choices.
 * @param service - configured defaults.
 * @param request - incoming request.
 * @param chatModels - models the chat input offers.
 * @param requireApproval - whether the settings ask before each generation.
 */
export function handleSession(
  store: SessionModelStore, service: MediaService, request: Request, chatModels?: ChatModels, requireApproval = true,
): Response {
  const sessionId = new URL(request.url).searchParams.get('sessionId')
  if (sessionId === null || sessionId.length === 0) return failure(400, 'sessionId is required')
  const choices = store.get(sessionId)
  const settings = service.settings()
  return Response.json({
    image: choices?.image ?? null,
    video: choices?.video ?? null,
    defaults: { image: settings.defaultImageModel ?? null, video: settings.defaultVideoModel ?? null },
    chatModels: { image: [...chatModels?.image ?? []], video: [...chatModels?.video ?? []] },
    approval: { required: requireApproval, allowedInSession: choices?.autoApprove === true },
  }, { headers: NO_STORE })
}

function optionalInteger(params: URLSearchParams, name: string): number | undefined {
  const raw = params.get(name)
  if (raw === null || raw === '') return undefined
  if (!/^\d+$/u.test(raw)) throw new MediaError('INVALID_REQUEST', `${name} must be a whole number`)
  return Number(raw)
}

/**
 * Estimate one generation as the card would request it, applying the
 * session's model choice. Validation errors come back as 400 with the reason.
 */
export async function handleEstimate(service: MediaService, store: SessionModelStore, request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams
  const kind = params.get('kind')
  if (kind !== 'image' && kind !== 'video') return failure(400, 'kind must be image or video')
  const text = (name: string) => { const v = params.get(name); return v === null || v === '' ? undefined : v }
  const sessionId = text('sessionId')
  try {
    const base = { prompt: 'estimate', model: text('model'), provider: text('provider'), aspect_ratio: text('aspect'), resolution: text('resolution') }
    const choice = sessionId === undefined ? undefined : store.get(sessionId)?.[kind]
    if (kind === 'image') {
      const plan = await service.plan(withSessionModel({
        ...base, count: optionalInteger(params, 'count'), input_images: params.getAll('image'),
      }, choice), request.signal)
      const cost = await service.estimate(plan, request.signal)
      return Response.json({
        model: { id: plan.model.id, name: plan.model.name }, provider: plan.provider.id,
        cost: cost === undefined ? null : { min: cost, max: cost },
      }, { headers: NO_STORE })
    }
    const audio = text('audio')
    const plan = await service.planVideo(withSessionModel({
      ...base, duration: optionalInteger(params, 'duration'), ...audio === undefined ? {} : { generate_audio: audio === 'on' },
      first_frame: text('first'), last_frame: text('last'),
    }, choice), request.signal)
    return Response.json({
      model: { id: plan.model.id, name: plan.model.name }, provider: plan.provider.id, cost: service.estimateVideo(plan) ?? null,
    }, { headers: NO_STORE })
  } catch (error) {
    return failure(error instanceof MediaError ? 400 : 502, error instanceof Error ? error.message : String(error))
  }
}

/** What the media views need: the saved-image index and the video jobs. */
export interface MediaSources {
  files: Promise<MediaFileIndex>
  jobs: Promise<VideoJobWatcher>
  /** The configured output directory, relative to a working directory (`generated-media`). */
  outputDir?: string
}

/** Whether `dir` ends with the output directory's path segments. Windows paths compare without case. */
export function inOutputDir(dir: string, outputDir: string): boolean {
  const fold = (p: string) => (sep === '\\' ? p.toLowerCase() : p)
  const want = normalize(outputDir).split(/[\\/]+/u).filter(part => part !== '' && part !== '.')
  if (want.length === 0 || want.includes('..')) return false
  const have = normalize(dir).split(/[\\/]+/u)
  if (have.length <= want.length) return false
  return want.every((part, i) => fold(have[have.length - want.length + i]!) === fold(part))
}

/**
 * Media type of an image directly inside an output directory, for images the
 * plugin saved before it kept its file index. The real path, after links,
 * must still be inside such a directory, and the file must be an image by
 * its signature, so the route serves nothing but generated-looking images.
 */
async function outputDirImage(path: string, outputDir: string | undefined): Promise<string | undefined> {
  if (outputDir === undefined || !isAbsolute(path) || normalize(path) !== path) return undefined
  if (!inOutputDir(dirname(path), outputDir)) return undefined
  try {
    const real = await realpath(path)
    if (!inOutputDir(dirname(real), outputDir)) return undefined
    const handle = await open(real, 'r')
    try {
      const head = new Uint8Array(16)
      const { bytesRead } = await handle.read(head, 0, head.length, 0)
      return sniffImage(head.subarray(0, bytesRead))
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
}

/** Media type of a file this plugin saved, or undefined for any other path. */
async function savedMediaType(sources: MediaSources, path: string): Promise<string | undefined> {
  const image = (await sources.files).get(path)
  if (image !== undefined) return image.mediaType
  for (const job of (await sources.jobs).store.list()) {
    const file = job.files.find(f => f.path === path)
    if (file !== undefined) return file.mediaType
  }
  return await outputDirImage(path, sources.outputDir)
}

/**
 * Serve one generated file. Only files this plugin saved, or images directly
 * inside an output directory, are served, so the route cannot read anything
 * else on the machine. Video players seek with
 * `Range`, which is answered with 206.
 */
export async function handleFile(sources: MediaSources, request: Request): Promise<Response> {
  const path = new URL(request.url).searchParams.get('path')
  if (path === null || path.length === 0) return failure(400, 'path is required')
  const mediaType = await savedMediaType(sources, path)
  if (mediaType === undefined) return failure(404, 'not a file this plugin generated')
  let size: number
  try {
    size = (await stat(path)).size
  } catch {
    return failure(404, 'the file is no longer there')
  }
  const headers: Record<string, string> = { 'content-type': mediaType, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' }
  const range = /^bytes=(\d*)-(\d*)$/u.exec(request.headers.get('range') ?? '')
  let start = 0
  let end = size - 1
  if (range !== null && (range[1] !== '' || range[2] !== '')) {
    if (range[1] === '') {
      start = Math.max(0, size - Number(range[2]))
    } else {
      start = Number(range[1])
      if (range[2] !== '') end = Math.min(end, Number(range[2]))
    }
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } })
    headers['content-range'] = `bytes ${start}-${end}/${size}`
  }
  headers['content-length'] = String(size === 0 ? 0 : end - start + 1)
  const status = headers['content-range'] === undefined ? 200 : 206
  if (request.method === 'HEAD' || size === 0) return new Response(null, { status, headers })
  const body = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream<Uint8Array>
  return new Response(body, { status, headers })
}

/** Report one video job for the chat's media view. */
export async function handleJob(sources: MediaSources, request: Request): Promise<Response> {
  const id = new URL(request.url).searchParams.get('id')
  if (id === null || id.length === 0) return failure(400, 'id is required')
  const job = (await sources.jobs).store.list().find(record => record.id === id)
  if (job === undefined) return failure(404, 'unknown video job')
  return Response.json({
    id: job.id, model: job.modelName, status: job.status, ...job.error === undefined ? {} : { error: job.error },
    files: job.files.map(f => ({ path: f.path, mediaType: f.mediaType })),
  }, { headers: NO_STORE })
}

/**
 * Register the routes.
 * @param fetch - DSH's connection fetch registry.
 * @param service - shared media service.
 * @param store - session choices, ready once their storage opened.
 * @param chatModels - models the chat input offers.
 * @param requireApproval - whether the settings ask before each generation.
 * @param media - saved files and video jobs for the chat's media views.
 */
export function registerRoutes(
  fetch: FetchRegistry, service: MediaService, store: Promise<SessionModelStore>, chatModels?: () => ChatModels, requireApproval?: () => boolean,
  media?: MediaSources,
): void {
  fetch.register({ path: MODELS_PATH, methods: ['GET'], requestBody: 'buffered', fetch: request => handleModels(service, request) })
  fetch.register({ path: SESSION_PATH, methods: ['GET'], requestBody: 'buffered', fetch: async request => handleSession(await store, service, request, chatModels?.(), requireApproval?.() ?? true) })
  fetch.register({ path: ESTIMATE_PATH, methods: ['GET'], requestBody: 'buffered', fetch: async request => handleEstimate(service, await store, request) })
  if (media !== undefined) {
    fetch.register({ path: FILE_PATH, methods: ['GET', 'HEAD'], requestBody: 'buffered', fetch: request => handleFile(media, request) })
    fetch.register({ path: JOB_PATH, methods: ['GET'], requestBody: 'buffered', fetch: request => handleJob(media, request) })
  }
}
