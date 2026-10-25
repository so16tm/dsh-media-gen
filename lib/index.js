/**
 * dsh-media-gen: image and video generation for DeepSeek Harness that reuses
 * the providers and credentials already configured in DSH.
 * @module dsh-media-gen
 */
import z from '@deepseek-ai/schemastery';
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm';
import { describeJob, MemoryJobStore, openDomainStore, VideoJobWatcher, } from "./jobs.js";
import { MEDIA_APPROVAL_COMMAND, MEDIA_MODEL_COMMAND, MemorySessionModelStore, openSessionModelStore, runMediaApprovalCommand, runMediaModelCommand, } from "./session-models.js";
import { IMAGE_COMMAND, IMAGE_HINT, runImageCommand, runVideoCommand, VIDEO_COMMAND, VIDEO_HINT, } from "./direct.js";
import { MemoryPromptNoteStore, openPromptNoteStore } from "./prompt-notes.js";
import { MemoryMediaFileIndex, openMediaFileIndex } from "./media-files.js";
import { registerRoutes } from "./routes.js";
import { TurnGuard } from "./turn-guard.js";
import { workingDirectory } from "./generate.js";
import { outsidePaths } from "./input-images.js";
import { MediaError } from "./errors.js";
import { formatCost, formatCostRange, localized, t } from "./messages.js";
import { ProviderBridge } from "./provider-bridge.js";
import { MediaService } from "./service.js";
import { imageToolArgs, registerTools, sessionArgs, sessionIdOf, TOOL_GENERATE_IMAGE, TOOL_GENERATE_VIDEO, TOOL_SET_PROMPT_NOTES } from "./tools.js";
/** Stable Loader identity. */
export const name = 'dsh-media-gen';
/**
 * Required services. Credentials, settings, attachments, the working
 * directory, the storage domain, and the agent registry are optional.
 */
export const inject = ['tools', 'llm'];
/** Validated configuration with defaults. */
export const Config = z.object({
    defaultImageProvider: z.string().volatile(),
    defaultImageModel: z.string().volatile(),
    maxImagesPerCall: z.natural().min(1).max(10).default(4).volatile(),
    defaultVideoProvider: z.string().volatile(),
    defaultVideoModel: z.string().volatile(),
    maxVideoSeconds: z.natural().min(1).max(120).default(10).volatile(),
    requireApproval: z.boolean().default(true).volatile(),
    outputDir: z.string().default('generated-media'),
    catalogTtlMs: z.natural().default(10 * 60_000),
    requestTimeoutMs: z.natural().min(1).default(180_000),
    maxImageBytes: z.natural().min(1).default(30 * 1024 * 1024),
    videoPollIntervalMs: z.natural().min(5_000).default(30_000).volatile(),
    videoMaxWatchMs: z.natural().min(60_000).default(3 * 60 * 60_000).volatile(),
    maxVideoBytes: z.natural().min(1).default(500 * 1024 * 1024).volatile(),
    notifyOnVideoCompletion: z.boolean().default(true).volatile(),
    chatImageModels: z.array(z.string()).default([]).volatile(),
    chatVideoModels: z.array(z.string()).default([]).volatile(),
});
/** Command listing video jobs, without the slash. */
const JOBS_COMMAND = 'media-jobs';
/** Message source of this plugin's in-session notices. */
const SOURCE_KIND = 'plugin:dsh-media-gen';
/** How long to wait for DSH's storage service before keeping records in memory only. */
const STORAGE_WAIT_MS = 10_000;
/** Prompt excerpt length shown in the approval prompt; the agent writes the prompt, so most of it is shown. */
const PROMPT_PREVIEW = 1500;
/** Tools that need the user's confirmation, which a subagent cannot ask for, unless generation is allowed without asking. */
const GENERATION_TOOLS = new Set([TOOL_GENERATE_IMAGE, TOOL_GENERATE_VIDEO]);
/** Whether an agent runs as a subagent another agent delegated to. */
function isSubagent(agent) {
    return agent?.session?.header?.origin === 'subagent';
}
/** Errors that mean the plugin refuses the request itself, before any charge. */
const REJECTED_REQUEST = new Set([
    'NO_PROVIDER', 'PROVIDER_NOT_FOUND', 'NO_MODEL', 'UNSUPPORTED_MODEL', 'UNSUPPORTED_PARAMETER', 'INVALID_REQUEST', 'LIMIT_EXCEEDED',
]);
/**
 * Register the media tools and the cost-approval gate.
 * @param ctx - plugin context.
 * @param config - validated configuration.
 */
export function apply(ctx, config) {
    const bridge = new ProviderBridge({
        llm: ctx.llm,
        get settings() { return ctx.get('settings'); },
        get credentials() { return ctx.get('credentials'); },
    });
    // Volatile fields are read on every use so settings edits apply without a reload.
    const service = new MediaService(bridge, () => ({
        defaultImageProvider: config.defaultImageProvider.get(),
        defaultImageModel: config.defaultImageModel.get(),
        maxImagesPerCall: config.maxImagesPerCall.get(),
        defaultVideoProvider: config.defaultVideoProvider.get(),
        defaultVideoModel: config.defaultVideoModel.get(),
        maxVideoSeconds: config.maxVideoSeconds.get(),
    }), { catalogTtlMs: config.catalogTtlMs, requestTimeoutMs: config.requestTimeoutMs });
    // Provider edits invalidate cached listings so a changed endpoint or key is used at once.
    ctx.on('llm/adapters-updated', () => service.catalog.clear());
    const get = (name) => ctx.get(name);
    // Reports a finished job: an idle session gets a new turn, a busy one sees it at its next step.
    const notify = (record, wake) => {
        if (!config.notifyOnVideoCompletion.get())
            return true;
        if (record.sessionId === undefined)
            return true;
        const agent = get('agents')?.get(record.sessionId);
        if (agent === undefined)
            return false;
        const message = createUserMessage({
            content: [{ type: 'text', text: describeJob(record) }],
            source: {
                kind: SOURCE_KIND,
                form: 'notice',
                summary: boundContextSummary(`Video job ${record.status === 'completed' ? 'finished' : record.status}: ${record.modelName}`),
            },
        });
        // A job the user started with `/video` bypassed the agent, so its outcome must not start an agent turn.
        if (wake && agent.status === 'idle' && record.origin !== 'command')
            agent.followup(message);
        else
            agent.inject(message);
        return true;
    };
    // DSH's storage-domain plugin may start after this one, so wait for its service instead of reading it once.
    const storageDomain = new Promise((resolve) => {
        const present = get('storageDomain');
        if (present !== undefined) {
            resolve(present);
            return;
        }
        const timer = setTimeout(() => { resolve(undefined); }, STORAGE_WAIT_MS);
        timer.unref?.();
        ctx
            .inject(['storageDomain'], (c) => { clearTimeout(timer); resolve(c.storageDomain); });
    });
    const store = storageDomain.then(domain => domain === undefined
        ? new MemoryJobStore()
        : openDomainStore(domain).catch((error) => {
            ctx.logger.warn(`dsh-media-gen: video jobs will not survive a restart; job storage failed to open: ${String(error)}`);
            return new MemoryJobStore();
        }));
    const videoJobs = store.then((jobs) => {
        const watcher = new VideoJobWatcher(jobs, service, () => ({
            pollIntervalMs: config.videoPollIntervalMs.get(),
            maxWatchMs: config.videoMaxWatchMs.get(),
            maxVideoBytes: config.maxVideoBytes.get(),
        }), record => notify(record, true), ctx.logger);
        watcher.start();
        return watcher;
    });
    ctx.effect(() => async () => {
        const watcher = await videoJobs;
        await watcher.dispose();
        await watcher.store.close?.();
    });
    ctx
        .on('agent/created', ({ agent }) => {
        void videoJobs.then(async (watcher) => {
            for (const record of watcher.store.list()) {
                if (record.delivered || record.sessionId !== agent.session.id)
                    continue;
                if (notify(record, false))
                    await watcher.store.put({ ...record, delivered: true });
            }
        });
    });
    const sessionModels = storageDomain.then(domain => domain === undefined
        ? new MemorySessionModelStore()
        : openSessionModelStore(domain).catch((error) => {
            ctx.logger.warn(`dsh-media-gen: session model choices will not survive a restart; their storage failed to open: ${String(error)}`);
            return new MemorySessionModelStore();
        }));
    ctx.effect(() => async () => { await (await sessionModels).close?.(); });
    const promptNotes = storageDomain.then(domain => domain === undefined
        ? new MemoryPromptNoteStore()
        : openPromptNoteStore(domain).catch((error) => {
            ctx.logger.warn(`dsh-media-gen: prompt notes will not survive a restart; their storage failed to open: ${String(error)}`);
            return new MemoryPromptNoteStore();
        }));
    ctx.effect(() => async () => { await (await promptNotes).close?.(); });
    const mediaFiles = storageDomain.then(domain => domain === undefined
        ? new MemoryMediaFileIndex()
        : openMediaFileIndex(domain).catch((error) => {
            ctx.logger.warn(`dsh-media-gen: generated images will not show in the chat after a restart; their index failed to open: ${String(error)}`);
            return new MemoryMediaFileIndex();
        }));
    ctx.effect(() => async () => { await (await mediaFiles).close?.(); });
    const generateConfig = {
        outputDir: config.outputDir,
        maxImageBytes: config.maxImageBytes,
        videoJobs,
        maxWatchMs: () => config.videoMaxWatchMs.get(),
        mediaFiles,
    };
    const direct = {
        ctx, service, config: generateConfig, sessionModels, requireApproval: () => config.requireApproval.get(),
    };
    // Whether the user allowed generation without asking in this session.
    const autoApproved = async (sessionId) => sessionId !== undefined && (await sessionModels).get(sessionId)?.autoApprove === true;
    ctx
        .inject(['commands'], (c) => {
        c.commands.register({
            name: MEDIA_MODEL_COMMAND,
            description: 'Choose the image or video generation model for this session',
            input: { hint: 'image|video <model-id> [provider]' },
            handler: async ({ agent, rawInput, signal }) => {
                const outcome = await runMediaModelCommand(await sessionModels, service, agent.session.id, rawInput, signal);
                const [kind, model] = rawInput.trim().split(/\s+/u);
                // Tell the agent at its next step, so it does not reuse a model id it saw before the change.
                if (outcome.kind === 'success' && (kind === 'image' || kind === 'video') && model !== undefined) {
                    agent.inject(createUserMessage({
                        content: [{ type: 'text', text: `The user changed the ${kind} generation model for this session: ${outcome.text}. `
                                    + `Leave model unset in media_generate_${kind} so this selection is used.` }],
                        source: { kind: SOURCE_KIND, form: 'notice', summary: boundContextSummary(`${kind} model changed`) },
                    }));
                }
                return outcome;
            },
        });
        c.commands.register({
            name: MEDIA_APPROVAL_COMMAND,
            description: 'Allow image and video generation without asking in this session, or ask again',
            input: { hint: 'on|off' },
            handler: async ({ agent, rawInput }) => runMediaApprovalCommand(await sessionModels, agent.session.id, rawInput, config.requireApproval.get()),
        });
        c.commands.register({
            name: IMAGE_COMMAND,
            description: 'Generate images from your prompt as written, without the agent',
            input: { hint: IMAGE_HINT },
            handler: ({ agent, rawInput, signal }) => runImageCommand(direct, rawInput, { agent, signal }),
        });
        c.commands.register({
            name: VIDEO_COMMAND,
            description: 'Start a video from your prompt as written, without the agent',
            input: { hint: VIDEO_HINT },
            handler: ({ agent, rawInput, signal }) => runVideoCommand(direct, rawInput, { agent, signal }),
        });
        c.commands.register({
            name: JOBS_COMMAND,
            description: 'Show the video jobs of this session, or check one now',
            input: { hint: '[job-id]' },
            handler: async ({ agent, rawInput, signal }) => {
                const watcher = await videoJobs;
                const id = rawInput.trim();
                try {
                    if (id.length > 0)
                        return { kind: 'success', text: describeJob(await watcher.check(id, signal)) };
                }
                catch (error) {
                    return { kind: 'error', text: String(error) };
                }
                const jobs = watcher.store.list().filter(job => job.sessionId === agent.session.id)
                    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 10);
                return { kind: 'success', text: jobs.length === 0 ? 'No video jobs in this session.' : jobs.map(describeJob).join('\n\n') };
            },
        });
    });
    ctx
        .inject(['connection'], (c) => {
        registerRoutes(c.connection.fetch, service, sessionModels, () => ({
            image: config.chatImageModels.get(), video: config.chatVideoModels.get(),
        }), () => config.requireApproval.get(), { files: mediaFiles, jobs: videoJobs, outputDir: config.outputDir });
    });
    registerTools(ctx, service, {
        ...generateConfig,
        requestTimeoutMs: config.requestTimeoutMs,
        sessionModels,
        promptNotes,
    });
    // A second generation in one turn is the agent acting on its own; it always asks.
    const turnGuard = new TurnGuard();
    ctx.on('agent/pre-step', async (step, next) => {
        turnGuard.enter(step.agent, step.turn);
        return await next();
    });
    // DSH rejects a subagent's approval questions without showing them, so a subagent offered a tool
    // that would ask could only try it and be rejected. It is offered generation only where no question
    // is needed, and never prompt notes, which always ask.
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
        const assembly = await next();
        const agent = context.agent;
        if (!isSubagent(agent))
            return assembly;
        const id = agent?.session?.id;
        const free = !config.requireApproval.get() || await autoApproved(typeof id === 'string' ? id : undefined);
        return {
            ...assembly,
            tools: assembly.tools.filter(tool => tool.name !== TOOL_SET_PROMPT_NOTES && (free || !GENERATION_TOOLS.has(tool.name))),
        };
    });
    // The cost gate runs outermost, so a listener that allows without calling
    // next() cannot skip it; the guard below denies any generation it never saw.
    const gated = new WeakSet();
    ctx.on('tools/pre-execute', async (exec, next) => {
        if (exec.name === TOOL_SET_PROMPT_NOTES) {
            // Notes reach every later session's agent, so the user sees what is saved.
            const downstream = await next();
            if (downstream.kind !== 'allow')
                return downstream;
            const args = exec.arguments;
            const notes = (lang) => t(lang, 'approval.notes', { model: String(args?.model ?? ''), notes: String(args?.notes ?? '') });
            return { kind: 'ask', reason: notes('en'), displayReason: localized(notes) };
        }
        if (exec.name !== TOOL_GENERATE_IMAGE && exec.name !== TOOL_GENERATE_VIDEO)
            return await next();
        gated.add(exec);
        const downstream = await next();
        if (downstream.kind === 'deny' || downstream.kind === 'cancel')
            return downstream;
        const repeat = turnGuard.repeat(exec.agent);
        // A file outside the working directory is sent away only after the user sees its path.
        const outside = await outsideInputs(exec);
        if (!repeat && outside.length === 0 && (!config.requireApproval.get() || await autoApproved(sessionIdOf(exec))))
            return downstream;
        const ours = await costQuestion(exec, repeat, outside);
        if (ours.kind !== 'ask' || downstream.kind !== 'ask' || downstream.reason === undefined)
            return ours;
        // Another policy asks too: one question carries both reasons.
        const reason = downstream.reason;
        return {
            kind: 'ask',
            reason: `${ours.reason ?? ''}\n${reason}`,
            displayReason: Object.fromEntries(Object.entries(ours.displayReason ?? { en: ours.reason ?? '' })
                .map(([lang, text]) => [lang, `${text}\n${downstream.displayReason?.[lang] ?? reason}`])),
        };
    }, { prepend: true });
    ctx.effect(() => ctx.tools.guard(exec => (exec.name === TOOL_GENERATE_IMAGE || exec.name === TOOL_GENERATE_VIDEO) && !gated.has(exec)
        ? 'media generation was allowed without its cost check; it was not run and nothing was charged'
        : undefined));
    /** Input image paths of a generation call that lie outside the session working directory. */
    async function outsideInputs(exec) {
        const raw = exec.arguments;
        const paths = [raw?.input_images, raw?.reference_images, raw?.first_frame, raw?.last_frame]
            .flatMap(v => (Array.isArray(v) ? v : [v])).filter((v) => typeof v === 'string' && v.trim() !== '').map(v => v.trim());
        if (paths.length === 0)
            return [];
        try {
            return outsidePaths(paths, await workingDirectory(ctx, exec));
        }
        catch {
            return paths;
        }
    }
    /** The approval question for one generation call; a call it cannot price still asks. */
    async function costQuestion(exec, repeat, outside) {
        const raw = exec.arguments;
        const args = exec.name === TOOL_GENERATE_IMAGE
            ? Array.isArray(raw?.prompts) && raw.prompts.length > 0 && raw.prompts.every(p => typeof p === 'string') ? imageToolArgs(raw) : undefined
            : raw;
        if (typeof args?.prompt !== 'string') {
            return { kind: 'deny', reason: `invalid arguments: ${exec.name === TOOL_GENERATE_IMAGE ? 'prompts must be a non-empty array of strings' : 'prompt must be a string'}; nothing was charged` };
        }
        const preview = (text) => (text.length > PROMPT_PREVIEW ? `${text.slice(0, PROMPT_PREVIEW)}…` : text);
        const prompt = preview(args.prompt);
        let text;
        let inputs = [];
        let variations = [];
        try {
            if (exec.name === TOOL_GENERATE_IMAGE) {
                const plan = await service.plan(await sessionArgs(sessionModels, 'image', args, exec), exec.signal);
                const cost = await service.estimate(plan, exec.signal);
                inputs = plan.inputs;
                variations = plan.variations;
                text = lang => t(lang, 'approval.image', {
                    count: String(plan.count * (1 + plan.variations.length)), model: plan.model.name, provider: plan.provider.id, cost: formatCost(lang, cost),
                });
            }
            else {
                const plan = await service.planVideo(await sessionArgs(sessionModels, 'video', args, exec), exec.signal);
                const cost = service.estimateVideo(plan);
                const { first, last, references } = plan.inputs;
                inputs = [
                    ...first === undefined ? [] : [`${first} (first frame)`],
                    ...last === undefined ? [] : [`${last} (last frame)`],
                    ...references,
                ];
                const duration = plan.params.duration;
                text = lang => t(lang, typeof duration === 'number' ? 'approval.video' : 'approval.video.default', {
                    model: plan.model.name, provider: plan.provider.id, cost: formatCostRange(lang, cost), seconds: String(duration),
                });
            }
        }
        catch (error) {
            // A request the plugin itself rejects would fail before any charge; say so now.
            if (error instanceof MediaError && REJECTED_REQUEST.has(error.code))
                return { kind: 'deny', reason: error.message };
            // Anything else (a model listing or credential lookup that failed) may
            // succeed by the time the call runs, so the user still decides.
            const detail = error instanceof MediaError ? error.message : 'the model listing could not be read';
            text = lang => t(lang, exec.name === TOOL_GENERATE_IMAGE ? 'approval.unpriced.image' : 'approval.unpriced.video', { detail });
        }
        const inputLine = (lang) => (inputs.length === 0 ? '' : `\n${t(lang, 'approval.inputs', { inputs: inputs.join(', ') })}`)
            + (outside.length === 0 ? '' : `\n${t(lang, 'approval.outside', { paths: outside.join(', ') })}`);
        const full = (lang) => `${repeat ? `${t(lang, 'approval.repeat')}\n` : ''}${text(lang)}${inputLine(lang)}\n${variations.length === 0 ? t(lang, 'approval.prompt', { prompt }) : t(lang, 'approval.variation', { n: '1', prompt })}`
            + variations.map((v, i) => `\n${t(lang, 'approval.variation', { n: String(i + 2), prompt: preview(v) })}`).join('')
            + `\n${t(lang, 'approval.session')}`;
        return { kind: 'ask', reason: full('en'), displayReason: localized(full) };
    }
}
