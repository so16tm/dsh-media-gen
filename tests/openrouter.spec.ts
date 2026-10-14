import { describe, expect, it } from 'vitest'
import {
  decodeBase64, OpenRouterAdapter, parseImageModels, parseImagePricing, parseParameterSpec, validateParams,
} from '../src/openrouter.ts'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const PNG_B64 = Buffer.from(PNG).toString('base64')

const MODELS_BODY = {
  data: [
    {
      id: 'google/gemini-image',
      name: 'Google: Gemini Image',
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['image'] },
      supported_parameters: {
        resolution: { enum: ['1K', '2K', '4K'] },
        aspect_ratio: ['1:1', '16:9'],
        n: { min: 1, max: 1 },
        seed: true,
        quality: false,
      },
    },
    { name: 'no id' },
  ],
}

function stubFetch(handler: (url: string, init: RequestInit) => { status?: number; body: unknown }) {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const { status = 200, body } = handler(url, init)
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('model listing parsing', () => {
  it('normalizes enum, range, and flag parameters and skips entries without id', () => {
    const [model, ...rest] = parseImageModels(MODELS_BODY)
    expect(rest).toEqual([])
    expect(model?.parameters).toEqual({
      resolution: { kind: 'enum', values: ['1K', '2K', '4K'] },
      aspect_ratio: { kind: 'enum', values: ['1:1', '16:9'] },
      n: { kind: 'range', min: 1, max: 1 },
      seed: { kind: 'boolean' },
    })
    expect(model?.outputModalities).toEqual(['image'])
  })

  it('keeps unknown parameter shapes as supported', () => {
    expect(parseParameterSpec({ something: 1 })).toEqual({ kind: 'any' })
    expect(parseImageModels({ data: [{ id: 'x', supported_parameters: ['size'] }] })[0]?.parameters).toEqual({ size: { kind: 'any' } })
  })

  it('collects pricing lines across endpoints', () => {
    const lines = parseImagePricing({ data: { endpoints: [
      { pricing: [{ billable: 'output_image', unit: 'image', cost_usd: '0.04', variant: '2k' }, { billable: 'x' }] },
      { pricing: [{ billable: 'input_image', unit: 'image', cost_usd: 0.01 }] },
    ] } })
    expect(lines).toEqual([
      { billable: 'output_image', unit: 'image', costUsd: 0.04, variant: '2k' },
      { billable: 'input_image', unit: 'image', costUsd: 0.01 },
    ])
  })
})

describe('validateParams', () => {
  const model = parseImageModels(MODELS_BODY)[0]!

  it('drops undefined values and canonicalizes enum case', () => {
    expect(validateParams(model, { resolution: '2k', aspect_ratio: undefined })).toEqual({ resolution: '2K' })
  })

  it('rejects undeclared parameters and out-of-range values instead of sending them', () => {
    expect(() => validateParams(model, { quality: 'high' })).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_PARAMETER' }))
    expect(() => validateParams(model, { aspect_ratio: '4:3' })).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_PARAMETER' }))
    expect(() => validateParams(model, { n: 2 })).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_PARAMETER' }))
  })
})

describe('OpenRouterAdapter', () => {
  it('sends the bearer key and parses images and cost', async () => {
    const { impl, calls } = stubFetch(() => ({ body: { data: [{ b64_json: PNG_B64, media_type: 'image/png' }], usage: { cost: 0.039 } } }))
    const adapter = new OpenRouterAdapter({ baseURL: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-test', fetch: impl, timeoutMs: 1000 })
    const result = await adapter.generateImage({ model: 'google/gemini-image', prompt: 'a cat', params: { resolution: '2K' } })
    expect(result.costUsd).toBe(0.039)
    expect(result.images[0]?.data).toEqual(PNG)
    expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/images')
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-or-test')
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ model: 'google/gemini-image', prompt: 'a cat', resolution: '2K' })
  })

  it('reports a missing cost as null', async () => {
    const { impl } = stubFetch(() => ({ body: { data: [{ b64_json: PNG_B64 }] } }))
    const adapter = new OpenRouterAdapter({ baseURL: 'https://x/api/v1', apiKey: 'k', fetch: impl, timeoutMs: 1000 })
    expect((await adapter.generateImage({ model: 'm', prompt: 'p', params: {} })).costUsd).toBeNull()
  })

  it.each([
    [401, 'AUTH_FAILED'], [402, 'INSUFFICIENT_BALANCE'], [429, 'RATE_LIMITED'], [400, 'INVALID_REQUEST'], [503, 'PROVIDER_ERROR'],
  ])('classifies HTTP %i as %s and redacts the key', async (status, code) => {
    const { impl } = stubFetch(() => ({ status, body: { error: { message: 'bad key sk-or-secret-value-123' } } }))
    const adapter = new OpenRouterAdapter({ baseURL: 'https://x/api/v1', apiKey: 'sk-or-secret-value-123', fetch: impl, timeoutMs: 1000 })
    const error = await adapter.generateImage({ model: 'm', prompt: 'p', params: {} }).catch((e: unknown) => e)
    expect(error).toMatchObject({ code, status })
    expect(String((error as Error).message)).not.toContain('sk-or-secret-value-123')
  })

  it('fails with INVALID_RESPONSE when no image decodes', async () => {
    const { impl } = stubFetch(() => ({ body: { data: [{ url: 'https://example.com/x.png' }] } }))
    const adapter = new OpenRouterAdapter({ baseURL: 'https://x/api/v1', apiKey: 'k', fetch: impl, timeoutMs: 1000 })
    await expect(adapter.generateImage({ model: 'm', prompt: 'p', params: {} })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('maps its own timeout to TIMEOUT', async () => {
    const impl = ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
    })) as unknown as typeof fetch
    const adapter = new OpenRouterAdapter({ baseURL: 'https://x/api/v1', apiKey: 'k', fetch: impl, timeoutMs: 20 })
    await expect(adapter.listImageModels()).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('encodes model ids in the pricing path', async () => {
    const { impl, calls } = stubFetch(() => ({ body: { data: { endpoints: [] } } }))
    const adapter = new OpenRouterAdapter({ baseURL: 'https://x/api/v1', apiKey: 'k', fetch: impl, timeoutMs: 1000 })
    await adapter.getImagePricing('google/gemini image')
    expect(calls[0]?.url).toBe('https://x/api/v1/images/models/google/gemini%20image/endpoints')
  })
})

describe('decodeBase64', () => {
  it('accepts data URLs and rejects non-base64 text', () => {
    expect(decodeBase64(`data:image/png;base64,${PNG_B64}`)).toEqual(PNG)
    expect(decodeBase64('<html>').byteLength).toBe(0)
  })
})
