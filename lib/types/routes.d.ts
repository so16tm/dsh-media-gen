/**
 * Routes: authenticated HTTP endpoints the browser half reads model lists and
 * session choices from. They run behind DSH's connection fence, so API keys
 * stay on the Host.
 * @module dsh-media-gen/src/routes
 */
import type { VideoJobWatcher } from './jobs.ts';
import type { MediaFileIndex } from './media-files.ts';
import type { ImageModel } from './openrouter.ts';
import type { MediaService } from './service.ts';
import { type SessionModelStore } from './session-models.ts';
import type { VideoModel } from './video.ts';
/** Model listing route. Query: `kind=image|video`, optional `refresh=1`. */
export declare const MODELS_PATH = "/api/media-gen.models";
/** Session choice route. Query: `sessionId`. */
export declare const SESSION_PATH = "/api/media-gen.session";
/**
 * Cost estimate route for the browser's generation card. Query: `kind`,
 * optional `sessionId`, `model`, `provider`, `aspect`, `resolution`,
 * `count`, `duration`, `audio=on|off`, and input image paths (`image`,
 * repeatable, for images; `first`, `last` for videos), which are checked
 * against the model but not read. Nothing is billed.
 */
export declare const ESTIMATE_PATH = "/api/media-gen.estimate";
/** Generated file route for the chat's media views. Query: `path`. Honors `Range`. */
export declare const FILE_PATH = "/api/media-gen.file";
/** Video job route for the chat's media views. Query: `id`. */
export declare const JOB_PATH = "/api/media-gen.job";
/** Values a picker can offer for one model; absent lists are free-form or unsupported. */
export interface ModelOptions {
    aspectRatios?: string[];
    resolutions?: string[];
    durations?: number[];
    /** Whether audio can be switched; undefined when the listing does not say. */
    audio?: boolean;
    /** Whether an image model takes input images; undefined when the listing does not say. */
    imageInput?: boolean;
    /** Frames a video model takes as images (`first_frame`, `last_frame`). */
    frameImages?: string[];
}
/** Picker values of an image model, from its parameter listing. */
export declare function imageOptions(model: ImageModel): ModelOptions;
/** Picker values of a video model. */
export declare function videoOptions(model: VideoModel): ModelOptions;
/** The part of DSH's connection fetch registry this plugin uses. */
export interface FetchRegistry {
    register(route: {
        path: string;
        methods: ('GET' | 'HEAD' | 'POST')[];
        requestBody: 'buffered' | 'streaming';
        fetch(request: Request): Promise<Response>;
    }): () => Promise<void>;
}
/**
 * List one kind's models for every media-capable provider.
 * @param service - provider resolution and cached listings.
 * @param request - incoming request.
 */
export declare function handleModels(service: MediaService, request: Request): Promise<Response>;
/** Model ids the chat input offers per kind; an empty list offers every listed model. */
export interface ChatModels {
    image: readonly string[];
    video: readonly string[];
}
/**
 * Report one session's choices and the configured defaults.
 * @param store - session choices.
 * @param service - configured defaults.
 * @param request - incoming request.
 * @param chatModels - models the chat input offers.
 * @param requireApproval - whether the settings ask before each generation.
 */
export declare function handleSession(store: SessionModelStore, service: MediaService, request: Request, chatModels?: ChatModels, requireApproval?: boolean): Response;
/**
 * Estimate one generation as the card would request it, applying the
 * session's model choice. Validation errors come back as 400 with the reason.
 */
export declare function handleEstimate(service: MediaService, store: SessionModelStore, request: Request): Promise<Response>;
/** What the media views need: the saved-image index and the video jobs. */
export interface MediaSources {
    files: Promise<MediaFileIndex>;
    jobs: Promise<VideoJobWatcher>;
    /** The configured output directory, relative to a working directory (`generated-media`). */
    outputDir?: string;
}
/** Whether `dir` ends with the output directory's path segments. Windows paths compare without case. */
export declare function inOutputDir(dir: string, outputDir: string): boolean;
/**
 * Serve one generated file. Only files this plugin saved, or images directly
 * inside an output directory, are served, so the route cannot read anything
 * else on the machine. Video players seek with
 * `Range`, which is answered with 206.
 */
export declare function handleFile(sources: MediaSources, request: Request): Promise<Response>;
/** Report one video job for the chat's media view. */
export declare function handleJob(sources: MediaSources, request: Request): Promise<Response>;
/**
 * Register the routes.
 * @param fetch - DSH's connection fetch registry.
 * @param service - shared media service.
 * @param store - session choices, ready once their storage opened.
 * @param chatModels - models the chat input offers.
 * @param requireApproval - whether the settings ask before each generation.
 * @param media - saved files and video jobs for the chat's media views.
 */
export declare function registerRoutes(fetch: FetchRegistry, service: MediaService, store: Promise<SessionModelStore>, chatModels?: () => ChatModels, requireApproval?: () => boolean, media?: MediaSources): void;
