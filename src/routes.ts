/**
 * Routes: authenticated HTTP endpoints the browser half reads model lists and
 * session choices from. They run behind DSH's connection fence, so API keys
 * stay on the Host.
 * @module dsh-media-gen/src/routes
 */

import { MediaError } from './errors.ts'
import type { ImageModel, ParameterSpec } from './openrouter.ts'
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
 * `count`, `duration`, `audio=on|off`. Nothing is billed.
 */
export const ESTIMATE_PATH = '/api/media-gen.estimate'

/** Values a picker can offer for one model; absent lists are free-form or unsupported. */
export interface ModelOptions {
  aspectRatios?: string[]
  resolutions?: string[]
  durations?: number[]
  /** Whether audio can be switched; undefined when the listing does not say. */
  audio?: boolean
}

function enumValues(spec: ParameterSpec | undefined): string[] | undefined {
  return spec?.kind === 'enum' ? spec.values.map(String) : undefined
}

/** Picker values of an image model, from its parameter listing. */
export function imageOptions(model: ImageModel): ModelOptions {
  const aspectRatios = enumValues(model.parameters.aspect_ratio)
  const resolutions = enumValues(model.parameters.resolution)
  return { ...aspectRatios === undefined ? {} : { aspectRatios }, ...resolutions === undefined ? {} : { resolutions } }
}

/** Picker values of a video model. */
export function videoOptions(model: VideoModel): ModelOptions {
  return {
    ...model.aspectRatios === undefined || model.aspectRatios.length === 0 ? {} : { aspectRatios: [...model.aspectRatios] },
    ...model.resolutions === undefined || model.resolutions.length === 0 ? {} : { resolutions: [...model.resolutions] },
    ...model.durations === undefined || model.durations.length === 0 ? {} : { durations: [...model.durations] },
    ...model.audio === undefined ? {} : { audio: model.audio },
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
 */
export function handleSession(store: SessionModelStore, service: MediaService, request: Request, chatModels?: ChatModels): Response {
  const sessionId = new URL(request.url).searchParams.get('sessionId')
  if (sessionId === null || sessionId.length === 0) return failure(400, 'sessionId is required')
  const choices = store.get(sessionId)
  const settings = service.settings()
  return Response.json({
    image: choices?.image ?? null,
    video: choices?.video ?? null,
    defaults: { image: settings.defaultImageModel ?? null, video: settings.defaultVideoModel ?? null },
    chatModels: { image: [...chatModels?.image ?? []], video: [...chatModels?.video ?? []] },
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
      const plan = await service.plan(withSessionModel({ ...base, count: optionalInteger(params, 'count') }, choice), request.signal)
      const cost = await service.estimate(plan, request.signal)
      return Response.json({
        model: { id: plan.model.id, name: plan.model.name }, provider: plan.provider.id,
        cost: cost === undefined ? null : { min: cost, max: cost },
      }, { headers: NO_STORE })
    }
    const audio = text('audio')
    const plan = await service.planVideo(withSessionModel({
      ...base, duration: optionalInteger(params, 'duration'), ...audio === undefined ? {} : { generate_audio: audio === 'on' },
    }, choice), request.signal)
    return Response.json({
      model: { id: plan.model.id, name: plan.model.name }, provider: plan.provider.id, cost: service.estimateVideo(plan) ?? null,
    }, { headers: NO_STORE })
  } catch (error) {
    return failure(error instanceof MediaError ? 400 : 502, error instanceof Error ? error.message : String(error))
  }
}

/**
 * Register the routes.
 * @param fetch - DSH's connection fetch registry.
 * @param service - shared media service.
 * @param store - session choices, ready once their storage opened.
 */
export function registerRoutes(fetch: FetchRegistry, service: MediaService, store: Promise<SessionModelStore>, chatModels?: () => ChatModels): void {
  fetch.register({ path: MODELS_PATH, methods: ['GET'], requestBody: 'buffered', fetch: request => handleModels(service, request) })
  fetch.register({ path: SESSION_PATH, methods: ['GET'], requestBody: 'buffered', fetch: async request => handleSession(await store, service, request, chatModels?.()) })
  fetch.register({ path: ESTIMATE_PATH, methods: ['GET'], requestBody: 'buffered', fetch: async request => handleEstimate(service, await store, request) })
}
