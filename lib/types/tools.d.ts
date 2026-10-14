/**
 * MediaTools: the model-facing tools. Descriptions are English because DSH
 * sends one tool description to every model regardless of display language.
 * @module dsh-media-gen/src/tools
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import { type GenerateConfig, type ImageToolValue } from './generate.ts';
import { type PromptNoteStore } from './prompt-notes.ts';
import { type MediaKind, type SessionModelStore } from './session-models.ts';
import type { ImageArgs, MediaService } from './service.ts';
/** Wire names of the tools; stable across languages. */
export declare const TOOL_LIST_MODELS = "media_list_models";
export declare const TOOL_GENERATE_IMAGE = "media_generate_image";
export declare const TOOL_GENERATE_VIDEO = "media_generate_video";
export declare const TOOL_VIDEO_STATUS = "media_video_status";
export declare const TOOL_GET_PROMPT_NOTES = "media_get_prompt_notes";
export declare const TOOL_SET_PROMPT_NOTES = "media_set_prompt_notes";
/**
 * The image tool's arguments as a plan request: the first prompt, then one
 * variation per further prompt. The tool has no count, so every image has
 * its own prompt.
 */
export declare function imageToolArgs<A extends {
    prompts?: readonly string[] | undefined;
}>(args: A): Omit<A, 'prompts'> & ImageArgs;
export { sessionIdOf, type ImageToolValue } from './generate.ts';
/** Settings and stores the tools need. */
export interface ToolConfig extends GenerateConfig {
    /** Per-request timeout for provider calls. */
    requestTimeoutMs: number;
    /** Per-session model choices, ready once their storage has opened. */
    sessionModels: Promise<SessionModelStore>;
    /** Prompt-writing notes by model id, ready once their storage has opened. */
    promptNotes: Promise<PromptNoteStore>;
}
/**
 * Apply the session's model choice. The choice made in the chat input wins
 * over a model the agent names, because the agent may repeat an id from
 * earlier in the conversation after the user switched; the agent's model
 * applies only while the session has no choice.
 * @param store - session choices.
 * @param exec - the tool call, whose agent identifies the session.
 */
export declare function sessionArgs<A extends {
    model?: string | undefined;
    provider?: string | undefined;
}>(store: Promise<SessionModelStore>, kind: MediaKind, args: A, exec: Pick<ToolExecution, 'agent'>): Promise<A>;
/**
 * Register the media tools.
 * @param ctx - plugin context.
 * @param service - shared media service.
 * @param config - output settings.
 */
export declare function registerTools(ctx: Context, service: MediaService, config: ToolConfig): void;
/**
 * Model-facing rendering: a text summary plus each durable image. Text-only
 * routes receive DSH's image placeholders instead of the pixels.
 */
export declare function renderImageResult(value: ImageToolValue): ContentBlock[];
