/**
 * PromptNotes: free-form notes on how to write prompts for one model, such
 * as the language it understands or whether it wants sentences or tags.
 * Providers publish nothing of the kind, so the notes are written on request
 * by the agent or the user and kept in DSH's storage domain by model id.
 * @module dsh-media-gen/src/prompt-notes
 */
import { MediaError } from "./errors.js";
import { openDomain } from "./storage.js";
/** Longest note kept for one model. */
export const MAX_NOTE_CHARS = 2000;
/** Validator for stored notes. */
export const promptNoteSchema = {
    parse(raw) {
        const value = raw;
        if (typeof value !== 'object' || value === null || typeof value.notes !== 'string' || typeof value.updatedAt !== 'string') {
            throw new Error('prompt note must be { notes, updatedAt }');
        }
        return value;
    },
};
/** Storage-domain declaration of the notes. */
export const PROMPT_NOTES_DOMAIN = {
    name: 'media_gen_notes',
    version: 1,
    tables: { notes: { valueSchema: promptNoteSchema } },
};
function normalize(model, notes) {
    const id = model.trim();
    if (id.length === 0)
        throw new MediaError('INVALID_REQUEST', 'model id is required');
    const text = notes.trim();
    if (text.length > MAX_NOTE_CHARS)
        throw new MediaError('INVALID_REQUEST', `notes are limited to ${MAX_NOTE_CHARS} characters; got ${text.length}`);
    return { model: id, notes: text };
}
/** Process-local store used when DSH offers no storage domain. */
export class MemoryPromptNoteStore {
    now;
    durable = false;
    rows = new Map();
    constructor(now = () => new Date()) {
        this.now = now;
    }
    get(model) { return this.rows.get(model); }
    list() { return [...this.rows.entries()]; }
    async set(model, notes) {
        const next = normalize(model, notes);
        if (next.notes.length === 0) {
            this.rows.delete(next.model);
            return undefined;
        }
        const note = { notes: next.notes, updatedAt: this.now().toISOString() };
        this.rows.set(next.model, note);
        return note;
    }
}
/** Open the durable store of notes. */
export async function openPromptNoteStore(service, attempts, delayMs) {
    const domain = await openDomain(service, PROMPT_NOTES_DOMAIN, attempts, delayMs);
    const table = domain.table('notes');
    return {
        durable: true,
        get: model => table.get(model),
        list: () => [...table.entries()],
        async set(model, notes) {
            const next = normalize(model, notes);
            if (next.notes.length === 0) {
                await table.delete(next.model);
                return undefined;
            }
            const note = { notes: next.notes, updatedAt: new Date().toISOString() };
            await table.put(next.model, note);
            return note;
        },
        close: () => domain.close(),
    };
}
