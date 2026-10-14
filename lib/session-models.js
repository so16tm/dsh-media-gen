/**
 * SessionModels: the image and video model chosen for one session, which
 * takes precedence over the configured defaults. Choices are kept in DSH's
 * storage domain keyed by session id, so they survive a restart.
 * @module dsh-media-gen/src/session-models
 */
import { MediaError } from "./errors.js";
import { openDomain } from "./storage.js";
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function parseChoice(raw, kind) {
    if (raw === undefined)
        return undefined;
    if (!isRecord(raw) || typeof raw.model !== 'string' || (raw.provider !== undefined && typeof raw.provider !== 'string')) {
        throw new Error(`session ${kind} model must be { model, provider? }`);
    }
    return raw;
}
/** Validator for stored session choices. */
export const sessionModelsSchema = {
    parse(raw) {
        if (!isRecord(raw) || typeof raw.updatedAt !== 'string')
            throw new Error('session models must carry updatedAt');
        parseChoice(raw.image, 'image');
        parseChoice(raw.video, 'video');
        if (raw.autoApprove !== undefined && typeof raw.autoApprove !== 'boolean')
            throw new Error('autoApprove must be a boolean');
        return raw;
    },
};
/** Storage-domain declaration of the session choices. */
export const SESSION_MODELS_DOMAIN = {
    name: 'media_gen_session',
    version: 1,
    tables: { models: { valueSchema: sessionModelsSchema } },
};
function nextValue(current, change, now) {
    const next = { ...current, updatedAt: now.toISOString() };
    if ('autoApprove' in change) {
        if (change.autoApprove)
            next.autoApprove = true;
        else
            delete next.autoApprove;
    }
    else if (change.choice === undefined) {
        delete next[change.kind];
    }
    else {
        next[change.kind] = change.choice;
    }
    return next.image === undefined && next.video === undefined && next.autoApprove === undefined ? undefined : next;
}
/** Process-local store used when DSH offers no storage domain. */
export class MemorySessionModelStore {
    now;
    durable = false;
    rows = new Map();
    constructor(now = () => new Date()) {
        this.now = now;
    }
    get(sessionId) { return this.rows.get(sessionId); }
    async set(sessionId, kind, choice) {
        this.apply(sessionId, { kind, choice });
    }
    async setAutoApprove(sessionId, on) {
        this.apply(sessionId, { autoApprove: on });
    }
    apply(sessionId, change) {
        const next = nextValue(this.rows.get(sessionId), change, this.now());
        if (next === undefined)
            this.rows.delete(sessionId);
        else
            this.rows.set(sessionId, next);
    }
}
/** Open the durable store of session choices. */
export async function openSessionModelStore(service, attempts, delayMs) {
    const domain = await openDomain(service, SESSION_MODELS_DOMAIN, attempts, delayMs);
    const table = domain.table('models');
    const apply = async (sessionId, change) => {
        const next = nextValue(table.get(sessionId), change, new Date());
        if (next === undefined)
            await table.delete(sessionId);
        else
            await table.put(sessionId, next);
    };
    return {
        durable: true,
        get: sessionId => table.get(sessionId),
        set: (sessionId, kind, choice) => apply(sessionId, { kind, choice }),
        setAutoApprove: (sessionId, on) => apply(sessionId, { autoApprove: on }),
        close: () => domain.close(),
    };
}
/** Command name, without the slash. */
export const MEDIA_MODEL_COMMAND = 'media-model';
const USAGE = `usage: /${MEDIA_MODEL_COMMAND} image|video <model-id> [provider] · /${MEDIA_MODEL_COMMAND} image|video default`;
/**
 * Run `/media-model` for one session. A bare command reports the current
 * choices; `image` or `video` alone lists the ids it accepts; with an id it
 * checks the id against the provider's listing before saving it.
 * @param store - session choices.
 * @param service - model listings and configured defaults.
 * @param sessionId - the calling session.
 * @param rawInput - text after the command name.
 */
export async function runMediaModelCommand(store, service, sessionId, rawInput, signal) {
    const [kindArg, modelArg, providerArg, ...rest] = rawInput.trim().split(/\s+/u).filter(part => part.length > 0);
    const settings = service.settings();
    const describe = (kind) => {
        const chosen = store.get(sessionId)?.[kind];
        const fallback = kind === 'image' ? settings.defaultImageModel : settings.defaultVideoModel;
        if (chosen !== undefined)
            return `${kind}: ${chosen.model} (this session)`;
        return fallback === undefined ? `${kind}: not set` : `${kind}: ${fallback} (default)`;
    };
    if (kindArg === undefined)
        return { kind: 'success', text: `${describe('image')} · ${describe('video')} · ${USAGE}` };
    if (kindArg !== 'image' && kindArg !== 'video')
        return { kind: 'error', text: `unknown kind "${kindArg}"; ${USAGE}` };
    if (rest.length > 0)
        return { kind: 'error', text: USAGE };
    const kind = kindArg;
    try {
        if (modelArg === undefined) {
            const provider = service.bridge.pick();
            const ids = await listIds(service, kind, provider, signal);
            return { kind: 'success', text: `${describe(kind)} · ${ids.length} ${kind} models on ${provider.id}: ${ids.join(', ')}` };
        }
        if (modelArg === 'default' || modelArg === 'reset') {
            await store.set(sessionId, kind, undefined);
            return { kind: 'success', text: `${kind} model for this session cleared; ${describe(kind)}` };
        }
        const provider = service.bridge.pick(providerArg);
        const ids = await listIds(service, kind, provider, signal);
        if (!ids.includes(modelArg)) {
            return { kind: 'error', text: `${provider.id} lists no ${kind} model "${modelArg}"; run /${MEDIA_MODEL_COMMAND} ${kind} to see the ids` };
        }
        await store.set(sessionId, kind, { model: modelArg, ...providerArg === undefined ? {} : { provider: provider.id } });
        return { kind: 'success', text: `${kind} model for this session: ${modelArg} (${provider.id})` };
    }
    catch (error) {
        return { kind: 'error', text: error instanceof MediaError ? error.message : String(error) };
    }
}
async function listIds(service, kind, provider, signal) {
    const options = signal === undefined ? {} : { signal };
    const snapshot = kind === 'image' ? await service.imageModels(provider, options) : await service.videoModels(provider, options);
    return snapshot.models.map(model => model.id);
}
/** Command that allows generation without asking in one session, without the slash. */
export const MEDIA_APPROVAL_COMMAND = 'media-approval';
/**
 * Run `/media-approval on|off` for one session. Only the user can run a
 * command, so the agent cannot lift its own approval.
 */
export async function runMediaApprovalCommand(store, sessionId, rawInput, requireApproval) {
    const arg = rawInput.trim();
    const state = () => store.get(sessionId)?.autoApprove === true
        ? 'generation in this session runs without asking'
        : 'each generation in this session asks first';
    if (!requireApproval)
        return { kind: 'success', text: 'Approval is turned off in the plugin settings; nothing asks before generating.' };
    if (arg === '')
        return { kind: 'success', text: `${state()} · usage: /${MEDIA_APPROVAL_COMMAND} on|off` };
    if (arg !== 'on' && arg !== 'off')
        return { kind: 'error', text: `usage: /${MEDIA_APPROVAL_COMMAND} on|off` };
    await store.setAutoApprove(sessionId, arg === 'on');
    return { kind: 'success', text: arg === 'on' ? 'Generation in this session now runs without asking.' : 'Each generation in this session asks first again.' };
}
/**
 * Fill in the session's choice when a call names no model.
 * @param args - tool arguments.
 * @param choice - the session's choice for this kind, if any.
 */
export function withSessionModel(args, choice) {
    if (args.model !== undefined || choice === undefined)
        return args;
    return { ...args, model: choice.model, ...args.provider === undefined && choice.provider !== undefined ? { provider: choice.provider } : {} };
}
