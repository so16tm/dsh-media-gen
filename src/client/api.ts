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
  /** Whether an image model takes input images; undefined when unknown. */
  imageInput?: boolean
  /** Frames a video model takes as images; undefined when unknown. */
  frameImages?: string[]
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
  /** Models the chat input offers; an empty list offers every listed model. Absent from older Hosts. */
  chatModels?: { image: string[]; video: string[] }
  /** Whether generation asks first, and whether this session allowed it without asking. Absent from older Hosts. */
  approval?: { required: boolean; allowedInSession: boolean }
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
export function loadEstimate(query: Record<string, string | readonly string[] | undefined>, signal?: AbortSignal): Promise<Estimate> {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    for (const v of typeof value === 'string' ? [value] : value ?? []) if (v !== '') params.append(key, v)
  }
  return getJson<Estimate>(`api/media-gen.estimate?${params.toString()}`, signal)
}

/** Whether a model can take the given kind's input images; true when its listing does not say. */
export function takesInputs(kind: MediaKind, model: ModelOption): boolean {
  return kind === 'image' ? model.options?.imageInput !== false : model.options?.frameImages?.includes('first_frame') ?? true
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

/**
 * The options the chat input offers: the configured subset when there is
 * one, plus the ids in `keep` (the current choice and the default) so a
 * selection never disappears from its own list.
 */
export function offeredOf(listing: ModelListing | undefined, subset: readonly string[] | undefined, keep: readonly (string | null | undefined)[]): ModelOption[] {
  const all = optionsOf(listing, undefined)
  if (subset === undefined || subset.length === 0) return optionsOf(listing, keep[0])
  const wanted = new Set([...subset, ...keep.filter((id): id is string => typeof id === 'string' && id.length > 0)])
  const out = all.filter(m => wanted.has(m.id))
  for (const id of wanted) if (!out.some(m => m.id === id)) out.push({ id, name: id })
  return out
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
