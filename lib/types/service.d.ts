/**
 * MediaService: resolves providers and models and runs image generation and
 * video job submission. Tools, the approval hook, and the job watcher share
 * one instance so they share one catalog cache.
 * @module dsh-media-gen/src/service
 */
import { CapabilityCatalog, type CatalogSnapshot } from './catalog.ts';
import { type InputImage } from './input-images.ts';
import { OpenRouterAdapter, type ImageModel, type ImageResult } from './openrouter.ts';
import type { MediaProvider, ProviderBridge } from './provider-bridge.ts';
import { type CostRange, type VideoArgs, type VideoInputs, type VideoJobState, type VideoModel } from './video.ts';
/** Live settings, read again on every use. */
export interface ServiceSettings {
    defaultImageProvider?: string | undefined;
    defaultImageModel?: string | undefined;
    maxImagesPerCall: number;
    defaultVideoProvider?: string | undefined;
    defaultVideoModel?: string | undefined;
    /** Longest video duration a call may request, in seconds. */
    maxVideoSeconds: number;
}
/** Settings fixed for the plugin's lifetime. */
export interface ServiceOptions {
    catalogTtlMs: number;
    requestTimeoutMs: number;
}
/** Arguments of one image generation. */
export interface ImageArgs {
    prompt: string;
    provider?: string | undefined;
    model?: string | undefined;
    count?: number | undefined;
    aspect_ratio?: string | undefined;
    resolution?: string | undefined;
    seed?: number | undefined;
    /** Reference images: paths in the working directory. */
    input_images?: string[] | undefined;
    /** Prompts of further images that differ from the first, one complete prompt each. */
    variations?: string[] | undefined;
}
/** A fully resolved generation plan, computed before anything is billed. */
export interface ImagePlan {
    provider: MediaProvider;
    model: ImageModel;
    count: number;
    params: Record<string, string | number | boolean>;
    /** Reference image paths, read when the plan runs. */
    inputs: string[];
    /** Prompts of further images, generated after the first prompt's. */
    variations: string[];
    /** True when the model listing could not be refreshed. */
    staleCatalog: boolean;
}
/** A fully resolved video job plan, computed before anything is billed. */
export interface VideoPlan {
    provider: MediaProvider;
    model: VideoModel;
    params: Record<string, string | number | boolean>;
    /** Input image paths, read when the job is submitted. */
    inputs: VideoInputs;
    staleCatalog: boolean;
}
/** A video's input images once read. */
export interface LoadedVideoInputs {
    first?: InputImage;
    last?: InputImage;
    references: InputImage[];
}
/** Number of input images a video sends. */
export declare function videoInputCount(inputs: VideoInputs): number;
/** Factory for adapters; replaced in tests. */
export type AdapterFactory = (provider: MediaProvider, apiKey: string, timeoutMs: number) => OpenRouterAdapter;
/** Model and provider resolution plus generation. */
export declare class MediaService {
    readonly bridge: ProviderBridge;
    readonly settings: () => ServiceSettings;
    private readonly options;
    private readonly createAdapter;
    readonly catalog: CapabilityCatalog;
    constructor(bridge: ProviderBridge, settings: () => ServiceSettings, options: ServiceOptions, createAdapter?: AdapterFactory);
    private adapter;
    /** List image models of one provider through the cache. */
    imageModels(provider: MediaProvider, options?: {
        refresh?: boolean;
        signal?: AbortSignal;
    }): Promise<CatalogSnapshot>;
    /**
     * Resolve provider, model, and parameters without spending anything.
     * @throws MediaError for every invalid choice.
     */
    plan(args: ImageArgs, signal?: AbortSignal): Promise<ImagePlan>;
    /** Estimate the plan's cost in USD; undefined when it cannot be estimated. */
    estimate(plan: ImagePlan, signal?: AbortSignal): Promise<number | undefined>;
    /** Run one planned generation. Sent once; never retried. */
    generate(plan: ImagePlan, prompt: string, signal?: AbortSignal, inputs?: readonly InputImage[]): Promise<ImageResult>;
    /** List video models of one provider through the cache. */
    videoModels(provider: MediaProvider, options?: {
        refresh?: boolean;
        signal?: AbortSignal;
    }): Promise<CatalogSnapshot<VideoModel>>;
    /**
     * Resolve provider, video model, and parameters without spending anything.
     * @throws MediaError for every invalid choice.
     */
    planVideo(args: VideoArgs, signal?: AbortSignal): Promise<VideoPlan>;
    /** Approximate the plan's cost; undefined when the SKUs cannot be read. */
    estimateVideo(plan: VideoPlan): CostRange | undefined;
    /** Submit one planned video job. Sent once; never retried. */
    submitVideo(plan: VideoPlan, prompt: string, signal?: AbortSignal, inputs?: LoadedVideoInputs): Promise<VideoJobState>;
    /** Read one job's state through the provider it was submitted to. */
    getVideoJob(providerId: string, jobId: string, signal?: AbortSignal): Promise<VideoJobState>;
    /** Download one output of a completed job. */
    downloadVideo(providerId: string, jobId: string, index: number, maxBytes: number, signal?: AbortSignal): Promise<{
        data: Uint8Array;
        contentType?: string;
    }>;
}
