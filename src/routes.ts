/**
 * Routes: authenticated HTTP endpoints the browser half reads model lists and
 * session choices from. They run behind DSH's connection fence, so API keys
 * stay on the Host.
 * @module dsh-media-gen/src/routes
 */

import type { MediaService } from './service.ts'
import type { SessionModelStore } from './session-models.ts'

/** Model listing route. Query: `kind=image|video`, optional `refresh=1`. */
export const MODELS_PATH = '/api/media-gen.models'

/** Session choice route. Query: `sessionId`. */
export const SESSION_PATH = '/api/media-gen.session'

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
      const snapshot = kind === 'image' ? await service.imageModels(provider, options) : await service.videoModels(provider, options)
      providers.push({
        id: provider.id,
        name: provider.name,
        stale: snapshot.stale,
        models: snapshot.models.map(model => ({ id: model.id, name: model.name })),
      })
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

/**
 * Report one session's choices and the configured defaults.
 * @param store - session choices.
 * @param service - configured defaults.
 * @param request - incoming request.
 */
export function handleSession(store: SessionModelStore, service: MediaService, request: Request): Response {
  const sessionId = new URL(request.url).searchParams.get('sessionId')
  if (sessionId === null || sessionId.length === 0) return failure(400, 'sessionId is required')
  const choices = store.get(sessionId)
  const settings = service.settings()
  return Response.json({
    image: choices?.image ?? null,
    video: choices?.video ?? null,
    defaults: { image: settings.defaultImageModel ?? null, video: settings.defaultVideoModel ?? null },
  }, { headers: NO_STORE })
}

/**
 * Register both routes.
 * @param fetch - DSH's connection fetch registry.
 * @param service - shared media service.
 * @param store - session choices, ready once their storage opened.
 */
export function registerRoutes(fetch: FetchRegistry, service: MediaService, store: Promise<SessionModelStore>): void {
  fetch.register({ path: MODELS_PATH, methods: ['GET'], requestBody: 'buffered', fetch: request => handleModels(service, request) })
  fetch.register({ path: SESSION_PATH, methods: ['GET'], requestBody: 'buffered', fetch: async request => handleSession(await store, service, request) })
}
