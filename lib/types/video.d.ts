/**
 * VideoModels: parsing and validation for OpenRouter's asynchronous Video
 * API. Capabilities and prices come from `GET /videos/models`; nothing about
 * a particular model is hard-coded.
 * @module dsh-media-gen/src/video
 */
/** Normalized video model capability. Absent lists mean the listing said nothing. */
export interface VideoModel {
    id: string;
    name: string;
    description?: string;
    resolutions?: readonly string[];
    aspectRatios?: readonly string[];
    sizes?: readonly string[];
    durations?: readonly number[];
    /** Whether audio can be generated; undefined when the listing does not say. */
    audio?: boolean;
    /** Whether a seed is honored; undefined when the listing does not say. */
    seed?: boolean;
    /** Frames an image can fix (`first_frame`, `last_frame`); undefined when the listing does not say. */
    frameImages?: readonly string[];
    /** Price per SKU in USD, with provider-specific SKU names. */
    pricingSkus: Readonly<Record<string, number>>;
}
/** Video job request after validation. */
export interface VideoRequest {
    model: string;
    prompt: string;
    params: Readonly<Record<string, string | number | boolean>>;
    /** Images fixing the first or last frame, as data or HTTP(S) URLs. */
    frameImages?: readonly {
        url: string;
        frameType: 'first_frame' | 'last_frame';
    }[];
    /** Reference images guiding the video, as data or HTTP(S) URLs. */
    inputReferences?: readonly string[];
}
/** Provider job states; the last four are terminal. */
export type VideoJobStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'expired';
/** True once the provider will not change the job any more. */
export declare function isTerminal(status: VideoJobStatus): boolean;
/** One observation of a provider job. */
export interface VideoJobState {
    id: string;
    status: VideoJobStatus;
    error?: string;
    /** Number of downloadable outputs, from `unsigned_urls`. */
    outputs: number;
    /** Actual charge in USD, once reported. */
    costUsd?: number;
}
/** Arguments of one video generation. */
export interface VideoArgs {
    prompt: string;
    provider?: string | undefined;
    model?: string | undefined;
    duration?: number | undefined;
    resolution?: string | undefined;
    aspect_ratio?: string | undefined;
    generate_audio?: boolean | undefined;
    seed?: number | undefined;
    /** Image fixing the first frame: a path in the working directory. */
    first_frame?: string | undefined;
    /** Image fixing the last frame. */
    last_frame?: string | undefined;
    /** Images guiding the look without fixing a frame. */
    reference_images?: string[] | undefined;
}
/** Parse `pricing_skus`, whose values are decimal strings; unparsable entries are dropped. */
export declare function parsePricingSkus(raw: unknown): Record<string, number>;
/**
 * Normalize the `GET /videos/models` body.
 * @param body - parsed JSON.
 * @returns models with an id; malformed entries are skipped.
 */
export declare function parseVideoModels(body: unknown): VideoModel[];
/**
 * Normalize a job body from `POST /videos` or `GET /videos/{id}`.
 * @returns the state, or undefined when the body names no job.
 */
export declare function parseVideoJob(body: unknown): VideoJobState | undefined;
/**
 * Validate optional parameters against a video model's listing. A list the
 * listing leaves empty is not enforced; the provider then decides.
 * @returns the parameters to send.
 * @throws MediaError UNSUPPORTED_PARAMETER for a value the model does not accept.
 */
export declare function validateVideoParams(model: VideoModel, args: VideoArgs): Record<string, string | number | boolean>;
/** The input images of one video, checked against the model before anything is read. */
export interface VideoInputs {
    first?: string;
    last?: string;
    references: string[];
}
/**
 * Check a video's input images against the listing. A model whose listing
 * names no frame support is refused frames; one that says nothing is let
 * through and the provider decides.
 * @throws MediaError UNSUPPORTED_PARAMETER for a frame the model cannot take.
 */
export declare function validateVideoInputs(model: VideoModel, args: VideoArgs, references: string[]): VideoInputs;
/** Approximate price of one job; a range when the SKUs leave the tier open. */
export interface CostRange {
    min: number;
    max: number;
}
/**
 * Estimate a job's price from `pricing_skus`. SKU names are provider
 * specific, so only two shapes are recognized: per-second SKUs (the name
 * mentions seconds) multiplied by the duration, and flat per-video SKUs. A
 * SKU naming a resolution counts only when it matches the requested one.
 * Anything else yields undefined rather than a guess.
 * @param model - the model listing.
 * @param duration - requested seconds; when absent, the model's duration range is used.
 * @param resolution - requested resolution, if any.
 * @param inputImages - input images sent, billed by models with a per-image SKU.
 */
export declare function estimateVideoCost(model: VideoModel, duration?: number, resolution?: string, inputImages?: number): CostRange | undefined;
/** Identify a supported video container from its signature. */
export declare function sniffVideo(data: Uint8Array): {
    mediaType: string;
    extension: string;
} | undefined;
