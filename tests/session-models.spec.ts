import { describe, expect, it } from 'vitest'
import { OpenRouterAdapter } from '../src/openrouter.ts'
import { ProviderBridge } from '../src/provider-bridge.ts'
import { MediaService } from '../src/service.ts'
import {
  MemorySessionModelStore, openSessionModelStore, runMediaModelCommand, sessionModelsSchema, withSessionModel,
} from '../src/session-models.ts'
import type { StorageDomainService } from '../src/storage.ts'

function service(defaults: { defaultImageModel?: string } = {}) {
  const fetchImpl = (async (url: string) => {
    if (url.endsWith('/images/models')) return Response.json({ data: [{ id: 'g/img', name: 'G' }, { id: 'h/img', name: 'H' }] })
    if (url.endsWith('/videos/models')) return Response.json({ data: [{ id: 'v/vid', name: 'V' }] })
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
  const bridge = new ProviderBridge({
    llm: { listProviders: () => [{ id: 'openrouter', name: 'OpenRouter' }], listConfigurableProviders: () => [] },
    env: { OPENROUTER_API_KEY: 'k' },
  })
  return new MediaService(bridge, () => ({ maxImagesPerCall: 4, maxVideoSeconds: 10, ...defaults }), { catalogTtlMs: 60_000, requestTimeoutMs: 1000 },
    (p, key, timeoutMs) => new OpenRouterAdapter({ baseURL: p.baseURL, apiKey: key, timeoutMs, fetch: fetchImpl }))
}

describe('/media-model', () => {
  it('reports the defaults, saves a listed id per session, and clears it again', async () => {
    const store = new MemorySessionModelStore()
    const svc = service({ defaultImageModel: 'g/img' })
    expect((await runMediaModelCommand(store, svc, 's1', '')).text).toContain('image: g/img (default) · video: not set')
    expect(await runMediaModelCommand(store, svc, 's1', ' image  h/img ')).toEqual({ kind: 'success', text: 'image model for this session: h/img (openrouter)' })
    expect(store.get('s1')?.image).toEqual({ model: 'h/img' })
    expect(store.get('s2')).toBeUndefined()
    expect((await runMediaModelCommand(store, svc, 's1', '')).text).toContain('image: h/img (this session)')
    expect((await runMediaModelCommand(store, svc, 's1', 'image default')).text).toContain('image: g/img (default)')
    expect(store.get('s1')).toBeUndefined()
  })

  it('lists ids for a kind and refuses unknown kinds and ids', async () => {
    const store = new MemorySessionModelStore()
    const svc = service()
    expect((await runMediaModelCommand(store, svc, 's1', 'video')).text).toContain('1 video models on openrouter: v/vid')
    expect(await runMediaModelCommand(store, svc, 's1', 'audio x')).toMatchObject({ kind: 'error' })
    expect(await runMediaModelCommand(store, svc, 's1', 'video g/img')).toMatchObject({ kind: 'error' })
    expect(await runMediaModelCommand(store, svc, 's1', 'video v/vid nope')).toMatchObject({ kind: 'error' })
    expect(store.get('s1')).toBeUndefined()
  })
})

describe('withSessionModel', () => {
  it('fills only a missing model and keeps an explicit one', () => {
    type Args = { prompt: string; model?: string; provider?: string }
    const bare: Args = { prompt: 'x' }
    expect(withSessionModel(bare, { model: 'h/img', provider: 'or' })).toEqual({ prompt: 'x', model: 'h/img', provider: 'or' })
    expect(withSessionModel({ prompt: 'x', model: 'g/img' }, { model: 'h/img' })).toEqual({ prompt: 'x', model: 'g/img' })
    expect(withSessionModel(bare, undefined)).toEqual({ prompt: 'x' })
  })
})

describe('session model storage', () => {
  it('validates records and keeps them in the storage domain', async () => {
    expect(() => sessionModelsSchema.parse({ image: { model: 1 }, updatedAt: 'x' })).toThrow()
    const rows = new Map<string, unknown>()
    const service: StorageDomainService = {
      async open(spec) {
        expect(spec.name).toBe('media_gen_session')
        return {
          table: () => ({
            get: (k: string) => rows.get(k),
            entries: () => rows.entries(),
            put: async (k: string, v: unknown) => { rows.set(k, sessionModelsSchema.parse(v)) },
            delete: async (k: string) => rows.delete(k),
          }),
          close: async () => {},
        }
      },
    }
    const store = await openSessionModelStore(service)
    await store.set('s1', 'video', { model: 'v/vid' })
    await store.set('s1', 'image', { model: 'g/img' })
    expect(store.get('s1')).toMatchObject({ image: { model: 'g/img' }, video: { model: 'v/vid' } })
    await store.set('s1', 'image', undefined)
    await store.set('s1', 'video', undefined)
    expect(rows.size).toBe(0)
  })
})
