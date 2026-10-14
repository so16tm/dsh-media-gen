/**
 * PromptNotes: free-form notes on how to write prompts for one model, such
 * as the language it understands or whether it wants sentences or tags.
 * Providers publish nothing of the kind, so the notes are written on request
 * by the agent or the user and kept in DSH's storage domain by model id.
 * @module dsh-media-gen/src/prompt-notes
 */
import { type StorageDomainService } from './storage.ts';
/** Longest note kept for one model. */
export declare const MAX_NOTE_CHARS = 2000;
/** The note of one model. */
export interface PromptNote {
    notes: string;
    updatedAt: string;
}
/** Validator for stored notes. */
export declare const promptNoteSchema: {
    parse(raw: unknown): PromptNote;
};
/** Storage-domain declaration of the notes. */
export declare const PROMPT_NOTES_DOMAIN: {
    readonly name: "media_gen_notes";
    readonly version: 1;
    readonly tables: {
        readonly notes: {
            readonly valueSchema: {
                parse(raw: unknown): PromptNote;
            };
        };
    };
};
/** Persistence of notes keyed by model id. */
export interface PromptNoteStore {
    get(model: string): PromptNote | undefined;
    list(): [string, PromptNote][];
    /** Set or, with an empty text, delete one model's note. */
    set(model: string, notes: string): Promise<PromptNote | undefined>;
    readonly durable: boolean;
    close?(): Promise<void>;
}
/** Process-local store used when DSH offers no storage domain. */
export declare class MemoryPromptNoteStore implements PromptNoteStore {
    private readonly now;
    readonly durable = false;
    private readonly rows;
    constructor(now?: () => Date);
    get(model: string): PromptNote | undefined;
    list(): [string, PromptNote][];
    set(model: string, notes: string): Promise<PromptNote | undefined>;
}
/** Open the durable store of notes. */
export declare function openPromptNoteStore(service: StorageDomainService, attempts?: number, delayMs?: number): Promise<PromptNoteStore>;
