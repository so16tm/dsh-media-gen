/**
 * OpenRouterAdapter: HTTP calls to OpenRouter's Image and Video APIs. Model ids
 * are never hard-coded; every capability comes from the model listings.
 * @module dsh-media-gen/src/openrouter
 */
import { type VideoJobState, type VideoModel, type VideoRequest } from './video.ts';
/** How one request parameter is constrained by a model. */
export type ParameterSpec = {
    kind: 'enum';
    values: readonly (string | number)[];
} | {
    kind: 'range';
    min?: number;
    max?: number;
} | {
    kind: 'boolean';
} | {
    kind: 'any';
};
/** One price line from a model's endpoint listing. */
export interface ImagePrice {
    /** What is billed, e.g. `output_image`. */
    billable: string;
    /** Billing unit, e.g. `image`, `megapixel`, `token`. */
    unit: string;
    /** Price in USD per unit. */
    costUsd: number;
    /** Optional variant such as a resolution tier (`2k`). */
    variant?: string;
}
/** Normalized image model capability. */
export interface ImageModel {
    id: string;
    name: string;
    description?: string;
    inputModalities: readonly string[];
    outputModalities: readonly string[];
    /** Supported request parameters keyed by wire name. */
    parameters: Readonly<Record<string, ParameterSpec>>;
}
/** Image generation request after validation. */
export interface ImageRequest {
    model: string;
    prompt: string;
    /** Optional parameters; only those the model supports are sent. */
    params: Readonly<Record<string, string | number | boolean>>;
    /** Reference images as data or HTTP(S) URLs, sent as `input_references`. */
    inputReferences?: readonly string[];
}
/** Content parts of `input_references`. */
export declare function imageParts(urls: readonly string[]): {
    type: 'image_url';
    image_url: {
        url: string;
    };
}[];
/** One generated image. */
export interface GeneratedImage {
    data: Uint8Array;
    /** Media type reported by the provider, if any. */
    mediaType?: string;
}
/** Image generation outcome. */
export interface ImageResult {
    images: GeneratedImage[];
    /** Actual charge in USD reported by OpenRouter; null when not reported. */
    costUsd: number | null;
}
/** Connection and transport options for one adapter instance. */
export interface OpenRouterOptions {
    baseURL: string;
    apiKey: string;
    fetch?: typeof fetch;
    /** Per-request timeout in milliseconds. */
    timeoutMs: number;
}
/**
 * Normalize one `supported_parameters` entry. The listing expresses each
 * parameter as an enum, a numeric range, or a flag; unknown shapes are kept
 * as `any` so a supported parameter is never silently dropped.
 */
export declare function parseParameterSpec(raw: unknown): ParameterSpec | undefined;
/**
 * Normalize the `GET /images/models` body.
 * @param body - parsed JSON.
 * @returns models with an id; malformed entries are skipped.
 */
export declare function parseImageModels(body: unknown): ImageModel[];
/**
 * Normalize the pricing lines of `GET /images/models/{id}/endpoints`. Every
 * endpoint's `pricing` array is collected; numeric strings are accepted.
 */
export declare function parseImagePricing(body: unknown): ImagePrice[];
/**
 * Validate optional parameters against a model's declared capability.
 * @returns the parameters to send.
 * @throws MediaError UNSUPPORTED_PARAMETER for an undeclared or out-of-range value.
 */
export declare function validateParams(model: ImageModel, params: Readonly<Record<string, string | number | boolean | undefined>>): Record<string, string | number | boolean>;
/** Thin client over OpenRouter's Image API. */
export declare class OpenRouterAdapter {
    private readonly options;
    private readonly fetchImpl;
    constructor(options: OpenRouterOptions);
    /** List image models with their supported parameters. */
    listImageModels(signal?: AbortSignal): Promise<ImageModel[]>;
    /** Read one model's per-endpoint pricing lines. */
    getImagePricing(modelId: string, signal?: AbortSignal): Promise<ImagePrice[]>;
    /**
     * Generate images synchronously. The request is sent once: a POST that may
     * already be billed is never retried automatically.
     */
    generateImage(request: ImageRequest, signal?: AbortSignal): Promise<ImageResult>;
    /** List video models with their supported options and pricing SKUs. */
    listVideoModels(signal?: AbortSignal): Promise<VideoModel[]>;
    /**
     * Submit one video job. Sent once: a POST that may already be billed is
     * never retried automatically.
     */
    submitVideo(request: VideoRequest, signal?: AbortSignal): Promise<VideoJobState>;
    /** Read the current state of one video job. */
    getVideoJob(jobId: string, signal?: AbortSignal): Promise<VideoJobState>;
    /**
     * Download one output of a completed job. The content URL is not presigned,
     * so it is fetched with the same credential as the API.
     * @param maxBytes - largest accepted body.
     */
    downloadVideo(jobId: string, index: number, maxBytes: number, signal?: AbortSignal): Promise<{
        data: Uint8Array;
        contentType?: string;
    }>;
    private request;
    /** Send one request and classify transport and HTTP failures; the caller reads the body. */
    private send;
}
/** Decode standard or data-URL Base64; invalid input yields an empty array. */
export declare function decodeBase64(value: string): Uint8Array;
