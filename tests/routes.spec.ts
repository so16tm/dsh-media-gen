import { describe, expect, it } from 'vitest'
import { OpenRouterAdapter } from '../src/openrouter.ts'
import { ProviderBridge } from '../src/provider-bridge.ts'
import { handleModels, handleSession, MODELS_PATH, registerRoutes, SESSION_PATH, type FetchRegistry } from '../src/routes.ts'
import { MediaService } from '../src/service.ts'
import { MemorySessionModelStore } from '../src/session-models.ts'

function service(failing = false) {
  let calls = 0
  const fetchImpl = (async (url: string) => {
    calls += 1
    if (failing) return Response.json({ error: { message: 'down' } }, { status: 500 })
    if (url.endsWith('/images/models')) return Response.json({ data: [{ id: 'g/img', name: 'G' }] })
    if (url.endsWith('/videos/models')) return Response.json({ data: [{ id: 'v/vid', name: 'V' }] })
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
  const bridge = new ProviderBridge({
    llm: { listProviders: () => [{ id: 'openrouter', name: 'OpenRouter' }], listConfigurableProviders: () => [] },
    env: { OPENROUTER_API_KEY: 'k' },
  })
  const svc = new MediaService(bridge, () => ({ maxImagesPerCall: 4, maxVideoSeconds: 10, defaultVideoModel: 'v/vid' }),
    { catalogTtlMs: 60_000, requestTimeoutMs: 1000 },
    (p, key, timeoutMs) => new OpenRouterAdapter({ baseURL: p.baseURL, apiKey: key, timeoutMs, fetch: fetchImpl }))
  return { svc, calls: () => calls }
}

const url = (path: string) => new Request(`http://host${path}`)

describe('model route', () => {
  it('lists one kind per provider with the configured default, and refreshes on request', async () => {
    const { svc, calls } = service()
    const response = await handleModels(svc, url(`${MODELS_PATH}?kind=video`))
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      kind: 'video',
      providers: [{ id: 'openrouter', name: 'OpenRouter', stale: false, models: [{ id: 'v/vid', name: 'V' }] }],
      default: 'v/vid',
    })
    await handleModels(svc, url(`${MODELS_PATH}?kind=video`))
    expect(calls()).toBe(1)
    await handleModels(svc, url(`${MODELS_PATH}?kind=video&refresh=1`))
    expect(calls()).toBe(2)
    expect((await (await handleModels(svc, url(`${MODELS_PATH}?kind=image`))).json()).default).toBeNull()
  })

  it('rejects an unknown kind and reports a provider failure', async () => {
    expect((await handleModels(service().svc, url(`${MODELS_PATH}?kind=audio`))).status).toBe(400)
    const failed = await handleModels(service(true).svc, url(`${MODELS_PATH}?kind=image`))
    expect(failed.status).toBe(502)
    expect(JSON.stringify(await failed.json())).not.toContain('"k"')
  })
})

describe('session route', () => {
  it('reports the session choices beside the defaults', async () => {
    const store = new MemorySessionModelStore()
    await store.set('s1', 'image', { model: 'g/img' })
    const { svc } = service()
    expect(await handleSession(store, svc, url(`${SESSION_PATH}?sessionId=s1`)).json())
      .toEqual({ image: { model: 'g/img' }, video: null, defaults: { image: null, video: 'v/vid' } })
    expect(handleSession(store, svc, url(SESSION_PATH)).status).toBe(400)
  })

  it('registers both routes for GET', async () => {
    const routes: Parameters<FetchRegistry['register']>[0][] = []
    registerRoutes({ register: (route) => { routes.push(route); return async () => {} } }, service().svc, Promise.resolve(new MemorySessionModelStore()))
    expect(routes.map(r => [r.path, r.methods])).toEqual([[MODELS_PATH, ['GET']], [SESSION_PATH, ['GET']]])
    expect((await routes[1]!.fetch(url(`${SESSION_PATH}?sessionId=x`))).status).toBe(200)
  })
})
