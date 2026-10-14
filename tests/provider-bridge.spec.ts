import { describe, expect, it } from 'vitest'
import { MediaError } from '../src/errors.ts'
import { normalizeOpenRouterBase, ProviderBridge, type ProviderBridgeDeps } from '../src/provider-bridge.ts'

function deps(overrides: Partial<ProviderBridgeDeps> = {}, profiles: Record<string, unknown> = {}): ProviderBridgeDeps {
  return {
    llm: {
      listProviders: () => [
        { id: 'deepseek-official', name: 'DeepSeek' },
        { id: 'openrouter', name: 'OpenRouter' },
        { id: 'my-gateway', name: 'Gateway' },
      ],
      listConfigurableProviders: () => [
        { provider: 'openrouter', displayName: 'OpenRouter', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openrouter'] },
        { provider: 'my-gateway', displayName: 'Gateway', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'my-gateway'] },
      ],
    },
    settings: { describe: () => [{ ns: 'llm-pi-ai', value: { providers: profiles } }] },
    ...overrides,
  }
}

describe('ProviderBridge', () => {
  it('finds the openrouter route with catalog defaults when no profile is stored', () => {
    const providers = new ProviderBridge(deps()).listProviders()
    expect(providers).toEqual([{
      id: 'openrouter', name: 'OpenRouter', kind: 'openrouter',
      baseURL: 'https://openrouter.ai/api/v1', credentialRef: 'OPENROUTER_API_KEY',
    }])
  })

  it('reads baseURL and apiKeyEnv from the stored profile and detects OpenRouter by host', () => {
    const providers = new ProviderBridge(deps({}, {
      'openrouter': { apiKeyEnv: 'OR_KEY' },
      'my-gateway': { baseURL: 'https://openrouter.ai/api/v1/', apiKeyEnv: 'GW_KEY' },
    })).listProviders()
    expect(providers.map(p => [p.id, p.baseURL, p.credentialRef])).toEqual([
      ['openrouter', 'https://openrouter.ai/api/v1', 'OR_KEY'],
      ['my-gateway', 'https://openrouter.ai/api/v1', 'GW_KEY'],
    ])
  })

  it('excludes a route named openrouter that points elsewhere', () => {
    const providers = new ProviderBridge(deps({}, { openrouter: { baseURL: 'https://example.com/v1' } })).listProviders()
    expect(providers).toEqual([])
  })

  it('requires a provider id when several are configured', () => {
    const bridge = new ProviderBridge(deps({}, { 'my-gateway': { baseURL: 'https://openrouter.ai' } }))
    expect(() => bridge.pick()).toThrow(MediaError)
    expect(bridge.pick('my-gateway').baseURL).toBe('https://openrouter.ai/api/v1')
  })

  it('reports NO_PROVIDER when nothing is configured', () => {
    const bridge = new ProviderBridge(deps({ llm: { listProviders: () => [], listConfigurableProviders: () => [] } }))
    expect(() => bridge.pick()).toThrow(expect.objectContaining({ code: 'NO_PROVIDER' }))
  })

  it('resolves the secret through the credentials service on every call', async () => {
    let calls = 0
    const bridge = new ProviderBridge(deps({
      credentials: { resolve: async () => { calls += 1; return { value: ' sk-or-secret ' } } },
    }))
    const provider = bridge.pick()
    expect(await bridge.resolveApiKey(provider)).toBe('sk-or-secret')
    await bridge.resolveApiKey(provider)
    expect(calls).toBe(2)
  })

  it('fails with MISSING_CREDENTIAL when the reference is unset', async () => {
    const bridge = new ProviderBridge(deps({ credentials: { resolve: async () => undefined } }))
    await expect(bridge.resolveApiKey(bridge.pick())).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  })

  it('falls back to the environment only without a credentials service', async () => {
    const bridge = new ProviderBridge(deps({ env: { OPENROUTER_API_KEY: 'from-env' } }))
    expect(await bridge.resolveApiKey(bridge.pick())).toBe('from-env')
  })
})

describe('normalizeOpenRouterBase', () => {
  it('appends /api/v1 to a bare host and keeps an explicit version', () => {
    expect(normalizeOpenRouterBase('https://openrouter.ai')).toBe('https://openrouter.ai/api/v1')
    expect(normalizeOpenRouterBase('https://openrouter.ai/api/v1/')).toBe('https://openrouter.ai/api/v1')
  })
})
