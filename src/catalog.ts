/**
 * CapabilityCatalog: cached, per-provider model listings with a TTL. A failed
 * refresh serves the previous listing marked stale instead of pretending it
 * is current.
 * @module dsh-media-gen/src/catalog
 */

import type { ImageModel, ImagePrice } from './openrouter.ts'

/** A listing and whether it may be out of date. */
export interface CatalogSnapshot {
  models: readonly ImageModel[]
  fetchedAt: number
  /** True when the last refresh failed and this is an older listing. */
  stale: boolean
}

/** Loader for one provider's listing. */
export type ModelLoader = (signal?: AbortSignal) => Promise<ImageModel[]>

/** Loader for one model's pricing. */
export type PricingLoader = (modelId: string, signal?: AbortSignal) => Promise<ImagePrice[]>

interface Entry { models: readonly ImageModel[]; fetchedAt: number }

/** Per-provider cache of image model listings and pricing. */
export class CapabilityCatalog {
  private readonly listings = new Map<string, Entry>()
  private readonly pricing = new Map<string, { lines: readonly ImagePrice[]; fetchedAt: number }>()

  constructor(private readonly ttlMs: number, private readonly now: () => number = Date.now) {}

  /**
   * Return a provider's listing, refreshing when expired or forced.
   * @throws the loader's error when nothing was ever cached.
   */
  async imageModels(providerId: string, load: ModelLoader, options?: { refresh?: boolean; signal?: AbortSignal }): Promise<CatalogSnapshot> {
    const cached = this.listings.get(providerId)
    const fresh = cached !== undefined && this.now() - cached.fetchedAt < this.ttlMs
    if (fresh && options?.refresh !== true) return { ...cached, stale: false }
    try {
      const models = await load(options?.signal)
      const entry = { models, fetchedAt: this.now() }
      this.listings.set(providerId, entry)
      return { ...entry, stale: false }
    } catch (error) {
      if (options?.signal?.aborted || cached === undefined) throw error
      return { ...cached, stale: true }
    }
  }

  /**
   * Return pricing lines for one model; undefined when unavailable. Pricing
   * failures never block generation, they only make the estimate unknown.
   */
  async imagePricing(providerId: string, modelId: string, load: PricingLoader, signal?: AbortSignal): Promise<readonly ImagePrice[] | undefined> {
    const key = `${providerId}\u0000${modelId}`
    const cached = this.pricing.get(key)
    if (cached !== undefined && this.now() - cached.fetchedAt < this.ttlMs) return cached.lines
    try {
      const lines = await load(modelId, signal)
      this.pricing.set(key, { lines, fetchedAt: this.now() })
      return lines
    } catch {
      return cached?.lines
    }
  }

  /** Drop every cached listing, e.g. after provider settings change. */
  clear(): void {
    this.listings.clear()
    this.pricing.clear()
  }
}

/**
 * Estimate a per-request price from pricing lines. Only per-image output
 * prices can be estimated before the call; megapixel or token pricing makes
 * the estimate unknown rather than guessed.
 * @param lines - the model's pricing lines.
 * @param count - number of images requested.
 * @param resolution - requested resolution tier, matched against `variant`.
 * @returns USD estimate, or undefined when it cannot be computed honestly.
 */
export function estimateImageCost(lines: readonly ImagePrice[] | undefined, count: number, resolution?: string): number | undefined {
  if (lines === undefined) return undefined
  const perImage = lines.filter(l => l.billable === 'output_image' && l.unit === 'image')
  if (perImage.length === 0) return undefined
  const wanted = resolution?.toLowerCase()
  const match = (wanted === undefined ? undefined : perImage.find(l => l.variant?.toLowerCase() === wanted))
    ?? perImage.find(l => l.variant === undefined)
    ?? (perImage.length === 1 ? perImage[0] : undefined)
  // Several tiers with no way to tell which applies: report the range's top.
  const price = match?.costUsd ?? Math.max(...perImage.map(l => l.costUsd))
  // Any other billable component (input images, tokens) makes this a lower bound only.
  return price * count
}
