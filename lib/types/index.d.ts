/**
 * dsh-media-gen: image and video generation for DeepSeek Harness that reuses
 * the providers and credentials already configured in DSH.
 * @module dsh-media-gen
 */
import type { Context, Volatile } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type ContextFormed } from '@deepseek-ai/dsh-llm';
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'plugin:dsh-media-gen': {
            kind: 'plugin:dsh-media-gen';
        } & ContextFormed;
    }
}
/** Stable Loader identity. */
export declare const name = "dsh-media-gen";
/**
 * Required services. Credentials, settings, attachments, the working
 * directory, the storage domain, and the agent registry are optional.
 */
export declare const inject: string[];
/** Plugin configuration. */
export interface Config {
    /** Default DSH provider id for image generation. */
    defaultImageProvider: Volatile<string | undefined>;
    /** Default image model id, e.g. one listed by media_list_models. */
    defaultImageModel: Volatile<string | undefined>;
    /** Upper bound of images per call. */
    maxImagesPerCall: Volatile<number>;
    /** Default DSH provider id for video generation. */
    defaultVideoProvider: Volatile<string | undefined>;
    /** Default video model id. */
    defaultVideoModel: Volatile<string | undefined>;
    /** Longest video duration a call may request, in seconds. */
    maxVideoSeconds: Volatile<number>;
    /** Ask the user before every billed generation. */
    requireApproval: Volatile<boolean>;
    /** Output directory relative to the session working directory. */
    outputDir: string;
    /** How long a model listing stays fresh. */
    catalogTtlMs: number;
    /** Per-request timeout for provider calls. */
    requestTimeoutMs: number;
    /** Largest accepted generated image. */
    maxImageBytes: number;
    /** Interval between checks of running video jobs. */
    videoPollIntervalMs: Volatile<number>;
    /** How long after submission a video job is watched. */
    videoMaxWatchMs: Volatile<number>;
    /** Largest accepted generated video. */
    maxVideoBytes: Volatile<number>;
    /** Tell the session when a video job ends. */
    notifyOnVideoCompletion: Volatile<boolean>;
    /** Image model ids the chat input offers; empty offers every listed model. */
    chatImageModels: Volatile<string[]>;
    /** Video model ids the chat input offers; empty offers every listed model. */
    chatVideoModels: Volatile<string[]>;
}
/** Validated configuration with defaults. */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    defaultImageProvider: z<string, string, "volatile">;
    defaultImageModel: z<string, string, "volatile">;
    maxImagesPerCall: z<number, number, "volatile-defined">;
    defaultVideoProvider: z<string, string, "volatile">;
    defaultVideoModel: z<string, string, "volatile">;
    maxVideoSeconds: z<number, number, "volatile-defined">;
    requireApproval: z<boolean, boolean, "volatile-defined">;
    outputDir: z<string, string, "defined">;
    catalogTtlMs: z<number, number, "defined">;
    requestTimeoutMs: z<number, number, "defined">;
    maxImageBytes: z<number, number, "defined">;
    videoPollIntervalMs: z<number, number, "volatile-defined">;
    videoMaxWatchMs: z<number, number, "volatile-defined">;
    maxVideoBytes: z<number, number, "volatile-defined">;
    notifyOnVideoCompletion: z<boolean, boolean, "volatile-defined">;
    chatImageModels: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    chatVideoModels: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    defaultImageProvider: z<string, string, "volatile">;
    defaultImageModel: z<string, string, "volatile">;
    maxImagesPerCall: z<number, number, "volatile-defined">;
    defaultVideoProvider: z<string, string, "volatile">;
    defaultVideoModel: z<string, string, "volatile">;
    maxVideoSeconds: z<number, number, "volatile-defined">;
    requireApproval: z<boolean, boolean, "volatile-defined">;
    outputDir: z<string, string, "defined">;
    catalogTtlMs: z<number, number, "defined">;
    requestTimeoutMs: z<number, number, "defined">;
    maxImageBytes: z<number, number, "defined">;
    videoPollIntervalMs: z<number, number, "volatile-defined">;
    videoMaxWatchMs: z<number, number, "volatile-defined">;
    maxVideoBytes: z<number, number, "volatile-defined">;
    notifyOnVideoCompletion: z<boolean, boolean, "volatile-defined">;
    chatImageModels: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    chatVideoModels: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
}>>, "plain">;
/**
 * Register the media tools and the cost-approval gate.
 * @param ctx - plugin context.
 * @param config - validated configuration.
 */
export declare function apply(ctx: Context, config: Config): void;
