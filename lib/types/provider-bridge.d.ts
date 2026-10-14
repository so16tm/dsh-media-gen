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
/** Provider families with a media adapter. */
export type MediaProviderKind = 'openrouter';
/** One DSH provider route that can serve media generation. */
export interface MediaProvider {
    /** DSH provider route key; models are addressed as `providerId + modelId`. */
    id: string;
    /** Display name from DSH. */
    name: string;
    /** Media adapter family. */
    kind: MediaProviderKind;
    /** API root such as `https://openrouter.ai/api/v1`, without a trailing slash. */
    baseURL: string;
    /** Credential reference (environment-variable name), never the secret. */
    credentialRef: string;
}
/** The slice of `ctx.llm` the bridge reads. */
export interface LlmDirectory {
    listProviders(): readonly {
        id: string;
        name: string;
    }[];
    listConfigurableProviders(): readonly {
        provider: string;
        displayName: string;
        settingsNs: string;
        settingsPath: readonly string[];
    }[];
}
/** The slice of `ctx.settings` the bridge reads. */
export interface SettingsReader {
    describe(options?: {
        redactSecrets?: boolean;
    }): readonly {
        ns: string;
        value: unknown;
    }[];
}
/** The slice of `ctx.credentials` the bridge uses. */
export interface CredentialResolver {
    resolve(ref: never): Promise<{
        value: string;
    } | undefined>;
}
/** Services the bridge reads; each may be absent in a minimal deployment. */
export interface ProviderBridgeDeps {
    llm: LlmDirectory;
    settings?: SettingsReader | undefined;
    credentials?: CredentialResolver | undefined;
    /** Environment fallback used only when no credentials service is mounted. */
    env?: Readonly<Record<string, string | undefined>>;
}
/** OpenRouter's public API root, used when a route stores no `baseURL`. */
export declare const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
/**
 * Credential reference pi-ai's own environment discovery uses for OpenRouter.
 * Applies only when the stored profile names no `apiKeyEnv`.
 */
export declare const OPENROUTER_DEFAULT_CREDENTIAL_REF = "OPENROUTER_API_KEY";
/** Normalize an OpenRouter root to `.../api/v1` without a trailing slash. */
export declare function normalizeOpenRouterBase(baseURL: string): string;
/** Joins DSH's provider routes with their stored profiles. */
export declare class ProviderBridge {
    private readonly deps;
    constructor(deps: ProviderBridgeDeps);
    /**
     * List every live DSH route that a media adapter can serve.
     * @returns media-capable providers in DSH's route order.
     */
    listProviders(): MediaProvider[];
    /**
     * Pick a provider by id, or the only one when no id is given.
     * @param id - optional DSH route key.
     * @returns the provider.
     * @throws MediaError NO_PROVIDER / PROVIDER_NOT_FOUND.
     */
    pick(id?: string): MediaProvider;
    /**
     * Resolve the provider's secret for one request. Never cached.
     * @param provider - the provider to authenticate.
     * @returns the API key.
     * @throws MediaError MISSING_CREDENTIAL.
     */
    resolveApiKey(provider: MediaProvider): Promise<string>;
}
