/**
 * ProviderBridge: the only place that reads DSH's provider configuration.
 *
 * DSH exposes provider routes through `ctx.llm` but not their endpoint or
 * credential reference, which live in the owning adapter's settings section.
 * The bridge joins the two: `listConfigurableProviders()` names the section
 * and path of each route's profile, and `ctx.settings.describe()` returns its
 * live value. Secrets are resolved through `ctx.credentials` on every request
 * and never stored. If DSH later offers a provider-connection API, only this
 * file changes.
 * @module dsh-media-gen/src/provider-bridge
 */

import { MediaError } from './errors.ts'

/** Provider families with a media adapter. */
export type MediaProviderKind = 'openrouter'

/** One DSH provider route that can serve media generation. */
export interface MediaProvider {
  /** DSH provider route key; models are addressed as `providerId + modelId`. */
  id: string
  /** Display name from DSH. */
  name: string
  /** Media adapter family. */
  kind: MediaProviderKind
  /** API root such as `https://openrouter.ai/api/v1`, without a trailing slash. */
  baseURL: string
  /** Credential reference (environment-variable name), never the secret. */
  credentialRef: string
}

/** The slice of `ctx.llm` the bridge reads. */
export interface LlmDirectory {
  listProviders(): readonly { id: string; name: string }[]
  listConfigurableProviders(): readonly {
    provider: string
    displayName: string
    settingsNs: string
    settingsPath: readonly string[]
  }[]
}

/** The slice of `ctx.settings` the bridge reads. */
export interface SettingsReader {
  describe(options?: { redactSecrets?: boolean }): readonly { ns: string; value: unknown }[]
}

/** The slice of `ctx.credentials` the bridge uses. */
export interface CredentialResolver {
  resolve(ref: never): Promise<{ value: string } | undefined>
}

/** Services the bridge reads; each may be absent in a minimal deployment. */
export interface ProviderBridgeDeps {
  llm: LlmDirectory
  settings?: SettingsReader | undefined
  credentials?: CredentialResolver | undefined
  /** Environment fallback used only when no credentials service is mounted. */
  env?: Readonly<Record<string, string | undefined>>
}

/** OpenRouter's public API root, used when a route stores no `baseURL`. */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

/**
 * Credential reference pi-ai's own environment discovery uses for OpenRouter.
 * Applies only when the stored profile names no `apiKeyEnv`.
 */
export const OPENROUTER_DEFAULT_CREDENTIAL_REF = 'OPENROUTER_API_KEY'

const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u

interface StoredProfile {
  baseURL?: string
  apiKeyEnv?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readPath(root: unknown, path: readonly string[]): unknown {
  let node = root
  for (const key of path) {
    if (!isRecord(node)) return undefined
    node = node[key]
  }
  return node
}

function readProfile(value: unknown): StoredProfile {
  if (!isRecord(value)) return {}
  const profile: StoredProfile = {}
  if (typeof value.baseURL === 'string' && value.baseURL.trim().length > 0) profile.baseURL = value.baseURL.trim()
  if (typeof value.apiKeyEnv === 'string' && value.apiKeyEnv.trim().length > 0) profile.apiKeyEnv = value.apiKeyEnv.trim()
  return profile
}

/**
 * Decide whether a route is OpenRouter: the route key itself, or a stored
 * endpoint on the openrouter.ai host.
 */
function isOpenRouter(routeId: string, baseURL: string | undefined): boolean {
  if (baseURL !== undefined) {
    try {
      const host = new URL(baseURL).hostname.toLowerCase()
      return host === 'openrouter.ai' || host.endsWith('.openrouter.ai')
    } catch {
      return false
    }
  }
  return routeId.toLowerCase() === 'openrouter'
}

/** Normalize an OpenRouter root to `.../api/v1` without a trailing slash. */
export function normalizeOpenRouterBase(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/u, '')
  return /\/api\/v\d+$/u.test(trimmed) ? trimmed : `${trimmed}/api/v1`
}

/** Joins DSH's provider routes with their stored profiles. */
export class ProviderBridge {
  constructor(private readonly deps: ProviderBridgeDeps) {}

  /**
   * List every live DSH route that a media adapter can serve.
   * @returns media-capable providers in DSH's route order.
   */
  listProviders(): MediaProvider[] {
    const live = this.deps.llm.listProviders()
    const directory = new Map(this.deps.llm.listConfigurableProviders().map(entry => [entry.provider, entry]))
    const sections = new Map((this.deps.settings?.describe({ redactSecrets: true }) ?? []).map(d => [d.ns, d.value]))
    const out: MediaProvider[] = []
    for (const route of live) {
      const entry = directory.get(route.id)
      const profile = entry === undefined ? {} : readProfile(readPath(sections.get(entry.settingsNs), entry.settingsPath))
      if (!isOpenRouter(route.id, profile.baseURL)) continue
      out.push({
        id: route.id,
        name: route.name,
        kind: 'openrouter',
        baseURL: normalizeOpenRouterBase(profile.baseURL ?? OPENROUTER_BASE_URL),
        credentialRef: profile.apiKeyEnv ?? OPENROUTER_DEFAULT_CREDENTIAL_REF,
      })
    }
    return out
  }

  /**
   * Pick a provider by id, or the only one when no id is given.
   * @param id - optional DSH route key.
   * @returns the provider.
   * @throws MediaError NO_PROVIDER / PROVIDER_NOT_FOUND.
   */
  pick(id?: string): MediaProvider {
    const providers = this.listProviders()
    if (providers.length === 0) {
      throw new MediaError('NO_PROVIDER', 'no OpenRouter provider is configured in DeepSeek Harness; add one on the Models settings page')
    }
    if (id === undefined) {
      if (providers.length > 1) {
        throw new MediaError('PROVIDER_NOT_FOUND', `several media-capable providers are configured (${providers.map(p => p.id).join(', ')}); name one with the provider argument`)
      }
      return providers[0]!
    }
    const hit = providers.find(p => p.id === id)
    if (hit === undefined) {
      throw new MediaError('PROVIDER_NOT_FOUND', `provider "${id}" is not a configured media-capable provider; configured: ${providers.map(p => p.id).join(', ')}`)
    }
    return hit
  }

  /**
   * Resolve the provider's secret for one request. Never cached.
   * @param provider - the provider to authenticate.
   * @returns the API key.
   * @throws MediaError MISSING_CREDENTIAL.
   */
  async resolveApiKey(provider: MediaProvider): Promise<string> {
    const ref = provider.credentialRef
    if (!CREDENTIAL_REF_PATTERN.test(ref)) {
      throw new MediaError('MISSING_CREDENTIAL', `provider "${provider.id}" names an invalid credential reference`)
    }
    const credentials = this.deps.credentials
    const value = credentials !== undefined
      ? (await credentials.resolve(ref as never))?.value
      : (this.deps.env ?? process.env)[ref]
    if (value === undefined || value.trim().length === 0) {
      throw new MediaError('MISSING_CREDENTIAL', `no credential is stored for ${ref}; set it on the Models settings page for provider "${provider.id}"`)
    }
    return value.trim()
  }
}
