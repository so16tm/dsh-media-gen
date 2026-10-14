/**
 * SessionModels: the image and video model chosen for one session, which
 * takes precedence over the configured defaults. Choices are kept in DSH's
 * storage domain keyed by session id, so they survive a restart.
 * @module dsh-media-gen/src/session-models
 */
import type { MediaService } from './service.ts';
import { type StorageDomainService } from './storage.ts';
/** What a model generates. */
export type MediaKind = 'image' | 'video';
/** One chosen model, with the provider it was chosen from. */
export interface ModelChoice {
    model: string;
    provider?: string;
}
/** Choices of one session. */
export interface SessionModels {
    image?: ModelChoice;
    video?: ModelChoice;
    /** The user allowed billed generation without asking again in this session. */
    autoApprove?: boolean;
    updatedAt: string;
}
/** Validator for stored session choices. */
export declare const sessionModelsSchema: {
    parse(raw: unknown): SessionModels;
};
/** Storage-domain declaration of the session choices. */
export declare const SESSION_MODELS_DOMAIN: {
    readonly name: "media_gen_session";
    readonly version: 1;
    readonly tables: {
        readonly models: {
            readonly valueSchema: {
                parse(raw: unknown): SessionModels;
            };
        };
    };
};
/** Persistence of per-session choices. */
export interface SessionModelStore {
    get(sessionId: string): SessionModels | undefined;
    /** Set or, with undefined, clear one kind's choice. */
    set(sessionId: string, kind: MediaKind, choice: ModelChoice | undefined): Promise<void>;
    /** Allow or stop billed generation without asking in one session. */
    setAutoApprove(sessionId: string, on: boolean): Promise<void>;
    readonly durable: boolean;
    close?(): Promise<void>;
}
/** Process-local store used when DSH offers no storage domain. */
export declare class MemorySessionModelStore implements SessionModelStore {
    private readonly now;
    readonly durable = false;
    private readonly rows;
    constructor(now?: () => Date);
    get(sessionId: string): SessionModels | undefined;
    set(sessionId: string, kind: MediaKind, choice: ModelChoice | undefined): Promise<void>;
    setAutoApprove(sessionId: string, on: boolean): Promise<void>;
    private apply;
}
/** Open the durable store of session choices. */
export declare function openSessionModelStore(service: StorageDomainService, attempts?: number, delayMs?: number): Promise<SessionModelStore>;
/** Command name, without the slash. */
export declare const MEDIA_MODEL_COMMAND = "media-model";
/** Outcome of one `/media-model` invocation. */
export type CommandOutcome = {
    kind: 'success';
    text: string;
} | {
    kind: 'error';
    text: string;
};
/**
 * Run `/media-model` for one session. A bare command reports the current
 * choices; `image` or `video` alone lists the ids it accepts; with an id it
 * checks the id against the provider's listing before saving it.
 * @param store - session choices.
 * @param service - model listings and configured defaults.
 * @param sessionId - the calling session.
 * @param rawInput - text after the command name.
 */
export declare function runMediaModelCommand(store: SessionModelStore, service: MediaService, sessionId: string, rawInput: string, signal?: AbortSignal): Promise<CommandOutcome>;
/** Command that allows generation without asking in one session, without the slash. */
export declare const MEDIA_APPROVAL_COMMAND = "media-approval";
/**
 * Run `/media-approval on|off` for one session. Only the user can run a
 * command, so the agent cannot lift its own approval.
 */
export declare function runMediaApprovalCommand(store: SessionModelStore, sessionId: string, rawInput: string, requireApproval: boolean): Promise<CommandOutcome>;
/**
 * Fill in the session's choice when a call names no model.
 * @param args - tool arguments.
 * @param choice - the session's choice for this kind, if any.
 */
export declare function withSessionModel<A extends {
    model?: string | undefined;
    provider?: string | undefined;
}>(args: A, choice: ModelChoice | undefined): A;
