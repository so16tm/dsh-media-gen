import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CapabilityCatalog, estimateImageCost } from '../src/catalog.ts'
import { formatCost, localized, t } from '../src/messages.ts'
import { OpenRouterAdapter } from '../src/openrouter.ts'
import { resolveOutputDir, saveImages, sniffImage } from '../src/output.ts'
import { ProviderBridge } from '../src/provider-bridge.ts'
import { MediaService, type ServiceSettings } from '../src/service.ts'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

function service(settings: Partial<ServiceSettings> = {}, body: Record<string, unknown> = {}) {
  const requests: string[] = []
  const fetchImpl = (async (url: string) => {
    requests.push(url)
    if (url.endsWith('/images/models')) {
      return Response.json({ data: [{ id: 'g/img', name: 'G Image', supported_parameters: { resolution: ['1K', '2K'], n: { min: 1, max: 4 } } }] })
    }
    if (url.endsWith('/endpoints')) {
      return Response.json({ data: { endpoints: [{ pricing: [
        { billable: 'output_image', unit: 'image', cost_usd: 0.03, variant: '1k' },
        { billable: 'output_image', unit: 'image', cost_usd: 0.06, variant: '2k' },
      ] }] } })
    }
    return Response.json({ data: [{ b64_json: Buffer.from(PNG).toString('base64') }], usage: { cost: 0.05 }, ...body })
  }) as unknown as typeof fetch
  const bridge = new ProviderBridge({
    llm: { listProviders: () => [{ id: 'openrouter', name: 'OpenRouter' }], listConfigurableProviders: () => [] },
    env: { OPENROUTER_API_KEY: 'k' },
  })
  const factory = (provider: { baseURL: string }, apiKey: string, timeoutMs: number) =>
    new OpenRouterAdapter({ baseURL: provider.baseURL, apiKey, timeoutMs, fetch: fetchImpl })
  const svc = new MediaService(bridge, () => ({ maxImagesPerCall: 4, maxVideoSeconds: 10, ...settings }), { catalogTtlMs: 60_000, requestTimeoutMs: 1000 }, factory)
  return { svc, requests, factory }
}

describe('MediaService', () => {
  it('plans with the default model, validates parameters, and sends n only above one image', async () => {
    const { svc } = service({ defaultImageModel: 'g/img' })
    const single = await svc.plan({ prompt: 'a cat', resolution: '2k' })
    expect(single.params).toEqual({ resolution: '2K' })
    const double = await svc.plan({ prompt: 'a cat', count: 2 })
    expect(double.params).toEqual({ n: 2 })
  })

  it('requires a model when no default is set and rejects unknown ids', async () => {
    const { svc } = service()
    await expect(svc.plan({ prompt: 'x' })).rejects.toMatchObject({ code: 'NO_MODEL' })
    await expect(svc.plan({ prompt: 'x', model: 'nope' })).rejects.toMatchObject({ code: 'UNSUPPORTED_MODEL' })
  })

  it('enforces the per-call limit and non-empty prompts before any network call', async () => {
    const { svc, requests } = service({ defaultImageModel: 'g/img', maxImagesPerCall: 2 })
    await expect(svc.plan({ prompt: 'x', count: 3 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    await expect(svc.plan({ prompt: '  ' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(requests).toEqual([])
  })

  it('reads live settings on every plan', async () => {
    let model: string | undefined
    const { svc, factory } = service()
    const live = new MediaService(svc.bridge, () => ({ maxImagesPerCall: 4, maxVideoSeconds: 10, defaultImageModel: model }), { catalogTtlMs: 1, requestTimeoutMs: 1000 }, factory)
    await expect(live.plan({ prompt: 'x' })).rejects.toMatchObject({ code: 'NO_MODEL' })
    model = 'g/img'
    expect((await live.plan({ prompt: 'x' })).model.id).toBe('g/img')
  })

  it('estimates by the requested resolution tier and generates once', async () => {
    const { svc, requests } = service({ defaultImageModel: 'g/img' })
    const plan = await svc.plan({ prompt: 'x', count: 2, resolution: '2K' })
    expect(await svc.estimate(plan)).toBeCloseTo(0.12)
    const result = await svc.generate(plan, 'x')
    expect(result.costUsd).toBe(0.05)
    expect(requests.filter(u => u.endsWith('/images'))).toHaveLength(1)
  })
})

describe('CapabilityCatalog', () => {
  it('caches within the TTL and serves a stale copy when a refresh fails', async () => {
    let now = 0
    const catalog = new CapabilityCatalog(100, () => now)
    let loads = 0
    const ok = async () => { loads += 1; return [{ id: 'a', name: 'a', inputModalities: [], outputModalities: [], parameters: {} }] }
    await catalog.imageModels('p', ok)
    await catalog.imageModels('p', ok)
    expect(loads).toBe(1)
    now = 200
    const snapshot = await catalog.imageModels('p', async () => { throw new Error('down') })
    expect(snapshot.stale).toBe(true)
    await expect(catalog.imageModels('q', async () => { throw new Error('down') })).rejects.toThrow('down')
  })
})

describe('estimateImageCost', () => {
  it('returns undefined rather than guessing for non per-image pricing', () => {
    expect(estimateImageCost([{ billable: 'output_image', unit: 'megapixel', costUsd: 0.01 }], 1)).toBeUndefined()
    expect(estimateImageCost(undefined, 1)).toBeUndefined()
    expect(estimateImageCost([{ billable: 'output_image', unit: 'image', costUsd: 0.04 }], 3)).toBeCloseTo(0.12)
  })
})

describe('output', () => {
  it('sniffs formats by signature', () => {
    expect(sniffImage(PNG)).toBe('image/png')
    expect(sniffImage(Uint8Array.from([0xff, 0xd8, 0xff, 0]))).toBe('image/jpeg')
    expect(sniffImage(new TextEncoder().encode('<svg/>'))).toBeUndefined()
  })

  it('keeps the output directory inside the working directory', () => {
    expect(resolveOutputDir('/w', 'generated-media')).toBe(resolve('/w', 'generated-media'))
    expect(() => resolveOutputDir('/w', '../x')).toThrow()
    expect(() => resolveOutputDir('/w', '/tmp')).toThrow()
  })

  it('writes files without overwriting and survives an attachment refusal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'media-'))
    const now = new Date(2026, 9, 14, 9, 5, 7)
    const attachments = {
      imageLimits: { mediaTypes: ['image/png'] },
      saveImage: async () => { throw new Error('too large') },
    } as never
    const { saved, attachmentFailures } = await saveImages([PNG], { dir, model: 'google/Gemini Image', attachments, now, maxBytes: 1000 })
    expect(saved[0]?.path).toBe(join(dir, '20261014-090507-google-gemini-image-1.png'))
    expect(await readFile(saved[0]!.path)).toEqual(Buffer.from(PNG))
    expect(attachmentFailures).toBe(1)
    await expect(saveImages([PNG], { dir, model: 'google/Gemini Image', now, maxBytes: 1000 })).rejects.toThrow()
  })

  it('refuses oversized or unknown data', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'media-'))
    await expect(saveImages([PNG], { dir, model: 'm', maxBytes: 4 })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    await expect(saveImages([Uint8Array.from([1, 2, 3])], { dir, model: 'm', maxBytes: 100 })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
})

describe('messages', () => {
  it('renders both languages and formats cost without changing the unit', () => {
    const text = localized(lang => t(lang, 'approval.image', { count: '2', model: 'M', provider: 'openrouter', cost: formatCost(lang, 0.12) }))
    expect(text.en).toBe('Generate 2 image(s) with M (openrouter). Estimated cost: about 0.12 USD.')
    expect(text.ja).toBe('M（openrouter）で画像を 2 枚生成します。概算料金：約 0.12 USD')
    expect(formatCost('ja', undefined)).toBe('不明')
  })

  it('falls back to English and then to the key', () => {
    expect(t('ja', 'missing.key')).toBe('missing.key')
  })
})
