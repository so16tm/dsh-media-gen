/**
 * Browser-side reads of the Host routes registered in src/routes.ts. Paths
 * are relative to the page, as DSH's own browser halves address their routes.
 * @module dsh-media-gen/src/client/api
 */

/** What a model generates. */
export type MediaKind = 'image' | 'video'

/** Values a model accepts, as the Host's listing reports them. */
export interface ModelCapabilities {
  aspectRatios?: string[]
  resolutions?: string[]
  durations?: number[]
  audio?: boolean
}

/** One model in a picker. */
export interface ModelOption {
  id: string
  name: string
  options?: ModelCapabilities
}

/** Estimate of one generation. */
export interface Estimate {
  model: { id: string; name: string }
  provider: string
  cost: { min: number; max: number } | null
}

/** Models of one kind across the media-capable providers. */
export interface ModelListing {
  providers: { id: string; name: string; stale: boolean; models: ModelOption[] }[]
  default: string | null
}

/** One session's choices and the configured defaults. */
export interface SessionChoices {
  image: { model: string; provider?: string } | null
  video: { model: string; provider?: string } | null
  defaults: { image: string | null; video: string | null }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...signal === undefined ? {} : { signal } })
  const body = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body
}

const listings = new Map<MediaKind, Promise<ModelListing>>()

/**
 * Read one kind's models, sharing one request between pickers until refreshed.
 * @param kind - image or video.
 * @param refresh - bypass the browser and Host caches.
 */
export function loadModels(kind: MediaKind, refresh = false): Promise<ModelListing> {
  const cached = listings.get(kind)
  if (cached !== undefined && !refresh) return cached
  const request = getJson<ModelListing>(`api/media-gen.models?kind=${kind}${refresh ? '&refresh=1' : ''}`)
  listings.set(kind, request)
  request.catch(() => { if (listings.get(kind) === request) listings.delete(kind) })
  return request
}

/** Read one session's choices. */
export function loadSessionChoices(sessionId: string, signal?: AbortSignal): Promise<SessionChoices> {
  return getJson<SessionChoices>(`api/media-gen.session?sessionId=${encodeURIComponent(sessionId)}`, signal)
}

/** Estimate one generation; rejects with the Host's reason when the parameters are invalid. */
export function loadEstimate(query: Record<string, string | undefined>, signal?: AbortSignal): Promise<Estimate> {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') params.set(key, value)
  return getJson<Estimate>(`api/media-gen.estimate?${params.toString()}`, signal)
}

/** Find one model across a listing's providers. */
export function findModel(listing: ModelListing | undefined, id: string | undefined): ModelOption | undefined {
  if (id === undefined) return undefined
  for (const provider of listing?.providers ?? []) {
    const found = provider.models.find(model => model.id === id)
    if (found !== undefined) return found
  }
  return undefined
}

/** Flatten a listing into picker options, keeping a current id that the listing lacks. */
export function optionsOf(listing: ModelListing | undefined, current: string | null | undefined): ModelOption[] {
  const seen = new Set<string>()
  const out: ModelOption[] = []
  for (const provider of listing?.providers ?? []) {
    for (const model of provider.models) {
      if (seen.has(model.id)) continue
      seen.add(model.id)
      out.push(model)
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  if (current !== null && current !== undefined && !seen.has(current)) out.unshift({ id: current, name: current })
  return out
}
