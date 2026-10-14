/**
 * Direct generation: `/image` and `/video` send the user's own prompt to the
 * chosen model without going through the agent. Options come first and the
 * rest of the line is the prompt, sent unchanged. While approval is on, a
 * command without `--yes` only shows the estimate, so typing the line again
 * with `--yes` is the approval.
 * @module dsh-media-gen/src/direct
 */
import type { Context } from '@deepseek-ai/cordis';
import { type Caller, type GenerateConfig } from './generate.ts';
import { type ImageArgs, type MediaService } from './service.ts';
import { type SessionModelStore } from './session-models.ts';
import type { VideoArgs } from './video.ts';
/** Command names, without the slash. */
export declare const IMAGE_COMMAND = "image";
export declare const VIDEO_COMMAND = "video";
/** Command input hints. */
export declare const IMAGE_HINT = "[--model id] [--aspect 1:1] [--resolution 1K] [--count n] [--seed n] [--image path]... [--yes] <prompt>";
export declare const VIDEO_HINT: string;
/** One parsed command line. */
export interface DirectRequest<A> {
    args: A;
    /** Whether the line carries `--yes`. */
    confirmed: boolean;
}
/** Parse an `/image` line. */
export declare function parseImageCommand(rawInput: string): DirectRequest<ImageArgs>;
/** Parse a `/video` line. */
export declare function parseVideoCommand(rawInput: string): DirectRequest<VideoArgs>;
/** What a direct command needs from the plugin. */
export interface DirectDeps {
    ctx: Context;
    service: MediaService;
    config: GenerateConfig;
    sessionModels: Promise<SessionModelStore>;
    requireApproval: () => boolean;
}
/** Outcome of one command. */
export type DirectOutcome = {
    kind: 'success';
    text: string;
} | {
    kind: 'error';
    text: string;
};
/** Run one `/image` line. Command results are English: the Host has no locale service for them. */
export declare function runImageCommand(deps: DirectDeps, rawInput: string, caller: Caller): Promise<DirectOutcome>;
/** Run one `/video` line. */
export declare function runVideoCommand(deps: DirectDeps, rawInput: string, caller: Caller): Promise<DirectOutcome>;
