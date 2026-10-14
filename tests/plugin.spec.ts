import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, Config } from '../src/index.ts'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

function fakeContext() {
  const listeners = new Map<string, (...args: never[]) => unknown>()
  const tools: { name: string }[] = []
  const ctx = {
    llm: {
      listProviders: () => [{ id: 'openrouter', name: 'OpenRouter' }],
      listConfigurableProviders: () => [],
    },
    tools: { register: (tool: { name: string }) => { tools.push(tool) } },
    on: (name: string, fn: (...args: never[]) => unknown) => { listeners.set(name, fn) },
    get: (name: string) => name === 'credentials' ? { resolve: async () => ({ value: 'sk-or-k' }) } : undefined,
  }
  return { ctx, listeners, tools }
}

function stubNetwork() {
  vi.stubGlobal('fetch', (async (url: string) => {
    if (url.endsWith('/images/models')) return Response.json({ data: [{ id: 'g/img', name: 'G Image', supported_parameters: {} }] })
    if (url.endsWith('/endpoints')) return Response.json({ data: { endpoints: [{ pricing: [{ billable: 'output_image', unit: 'image', cost_usd: 0.04 }] }] } })
    return Response.json({ data: [{ b64_json: Buffer.from(PNG).toString('base64') }] })
  }) as unknown as typeof fetch)
}

afterEach(() => { vi.unstubAllGlobals() })

describe('plugin apply', () => {
  it('registers both tools', () => {
    const { ctx, tools } = fakeContext()
    apply(ctx as never, Config({}) as never)
    expect(tools.map(t => t.name)).toEqual(['media_list_models', 'media_generate_image'])
  })

  it('asks for approval with a localized cost estimate', async () => {
    stubNetwork()
    const { ctx, listeners } = fakeContext()
    apply(ctx as never, Config({ defaultImageModel: 'g/img' }) as never)
    const hook = listeners.get('tools/pre-execute') as unknown as (exec: unknown, next: () => Promise<unknown>) => Promise<unknown>
    const decision = await hook(
      { name: 'media_generate_image', arguments: { prompt: 'a cat' }, signal: new AbortController().signal },
      async () => ({ kind: 'allow' }),
    ) as { kind: string; displayReason: Record<string, string> }
    expect(decision.kind).toBe('ask')
    expect(decision.displayReason.en).toContain('Estimated cost: about 0.04 USD')
    expect(decision.displayReason.ja).toContain('概算料金：約 0.04 USD')
  })

  it('leaves other tools, denials, and disabled approval untouched', async () => {
    const { ctx, listeners } = fakeContext()
    apply(ctx as never, Config({ requireApproval: false, defaultImageModel: 'g/img' }) as never)
    const hook = listeners.get('tools/pre-execute') as unknown as (exec: unknown, next: () => Promise<unknown>) => Promise<unknown>
    const signal = new AbortController().signal
    expect(await hook({ name: 'media_generate_image', arguments: { prompt: 'x' }, signal }, async () => ({ kind: 'allow' }))).toEqual({ kind: 'allow' })
    expect(await hook({ name: 'bash', arguments: {}, signal }, async () => ({ kind: 'deny', reason: 'no' }))).toEqual({ kind: 'deny', reason: 'no' })
  })
})
