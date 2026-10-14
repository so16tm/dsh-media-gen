/**
 * Generate: one image generation or one video submission, shared by the
 * model-facing tools and the direct `/image` and `/video` commands.
 * @module dsh-media-gen/src/generate
 */
import type { Context } from '@deepseek-ai/cordis';
import type { VideoJobRecord, VideoJobWatcher } from './jobs.ts';
import type { MediaFileIndex } from './media-files.ts';
import type { ImagePlan, MediaService, VideoPlan } from './service.ts';
/** The calling agent and the request's cancellation. */
export interface Caller {
    agent?: unknown;
    signal?: AbortSignal | undefined;
}
/** Session id of the calling agent, when it runs inside one. */
export declare function sessionIdOf(caller: Pick<Caller, 'agent'>): string | undefined;
/**
 * Resolve the session working directory. DSH 0.2.1 provides a
 * `workingDirectory` service; 0.2.0 records it on the session header. A
 * deployment with neither falls back to the Host process directory.
 */
export declare function workingDirectory(ctx: Context, caller: Caller): Promise<string>;
/** Output settings generation needs. */
export interface GenerateConfig {
    outputDir: string;
    maxImageBytes: number;
    videoJobs: Promise<VideoJobWatcher>;
    maxWatchMs: () => number;
    /** Index the chat's media views read saved images from. */
    mediaFiles?: Promise<MediaFileIndex>;
}
/** Canonical value of one image generation. */
export interface ImageToolValue {
    provider: string;
    model: string;
    images: {
        path: string;
        mediaType: string;
        bytes: number;
        attachment?: Record<string, unknown>;
    }[];
    costUsd: number | null;
    staleCatalog: boolean;
    attachmentFailures: number;
    /** Why a later variation failed after earlier images were saved. */
    failed?: string;
}
/**
 * Generate and save the images of one plan: the prompt, then each
 * variation, one provider call each. A failure after an image was saved
 * stops the rest and is reported with what was saved.
 * @param prompt - the text sent to the model, unchanged.
 */
export declare function runImagePlan(ctx: Context, service: MediaService, config: GenerateConfig, plan: ImagePlan, prompt: string, caller: Caller): Promise<ImageToolValue>;
/**
 * Submit one planned video job and hand it to the watcher.
 * @param prompt - the text sent to the model, unchanged.
 * @param origin - who asked: the agent's tool call or the user's command.
 */
export declare function startVideoPlan(ctx: Context, service: MediaService, config: GenerateConfig, plan: VideoPlan, prompt: string, caller: Caller, origin: 'agent' | 'command'): Promise<VideoJobRecord>;
