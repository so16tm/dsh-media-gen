/**
 * CapabilityCatalog: cached, per-provider model listings with a TTL. A failed
 * refresh serves the previous listing marked stale instead of pretending it
 * is current.
 * @module dsh-media-gen/src/catalog
 */
import type { ImageModel, ImagePrice } from './openrouter.ts';
import type { VideoModel } from './video.ts';
/** A listing and whether it may be out of date. */
export interface CatalogSnapshot<M = ImageModel> {
    models: readonly M[];
    fetchedAt: number;
    /** True when the last refresh failed and this is an older listing. */
    stale: boolean;
}
/** Loader for one provider's listing. */
export type ModelLoader<M = ImageModel> = (signal?: AbortSignal) => Promise<M[]>;
/** Loader for one model's pricing. */
export type PricingLoader = (modelId: string, signal?: AbortSignal) => Promise<ImagePrice[]>;
/** Per-provider cache of image and video model listings and image pricing. */
export declare class CapabilityCatalog {
    private readonly ttlMs;
    private readonly now;
    private readonly listings;
    private readonly pricing;
    constructor(ttlMs: number, now?: () => number);
    /**
     * Return a provider's image listing, refreshing when expired or forced.
     * @throws the loader's error when nothing was ever cached.
     */
    imageModels(providerId: string, load: ModelLoader, options?: {
        refresh?: boolean;
        signal?: AbortSignal;
    }): Promise<CatalogSnapshot>;
    /** Return a provider's video listing; same caching as {@link imageModels}. */
    videoModels(providerId: string, load: ModelLoader<VideoModel>, options?: {
        refresh?: boolean;
        signal?: AbortSignal;
    }): Promise<CatalogSnapshot<VideoModel>>;
    private listing;
    /**
     * Return pricing lines for one model; undefined when unavailable. Pricing
     * failures never block generation, they only make the estimate unknown.
     */
    imagePricing(providerId: string, modelId: string, load: PricingLoader, signal?: AbortSignal): Promise<readonly ImagePrice[] | undefined>;
    /** Drop every cached listing, e.g. after provider settings change. */
    clear(): void;
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
export declare function estimateImageCost(lines: readonly ImagePrice[] | undefined, count: number, resolution?: string): number | undefined;
