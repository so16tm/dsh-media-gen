/**
 * Generate: one image generation or one video submission, shared by the
 * model-facing tools and the direct `/image` and `/video` commands.
 * @module dsh-media-gen/src/generate
 */
import { MediaError } from "./errors.js";
import { resolveOutputDir, saveImages } from "./output.js";
import { loadInputImage, loadInputImages } from "./input-images.js";
/** Prompt excerpt stored with a video job. */
const PROMPT_EXCERPT = 200;
/** Session id of the calling agent, when it runs inside one. */
export function sessionIdOf(caller) {
    const id = caller.agent?.session?.id;
    return typeof id === 'string' && id.length > 0 ? id : undefined;
}
/**
 * Resolve the session working directory. DSH 0.2.1 provides a
 * `workingDirectory` service; 0.2.0 records it on the session header. A
 * deployment with neither falls back to the Host process directory.
 */
export async function workingDirectory(ctx, caller) {
    const agent = caller.agent;
    const service = ctx.get('workingDirectory');
    if (service !== undefined && agent !== undefined)
        return service.ensure(agent, caller.signal);
    const cwd = agent?.session?.header?.cwd;
    return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd();
}
/**
 * Mark a failure after which the provider may already have billed the request:
 * a timeout, or a response that could not be used. The agent must not retry it
 * on its own.
 */
function maybeCharged(error) {
    if (!(error instanceof MediaError) || (error.code !== 'TIMEOUT' && error.code !== 'INVALID_RESPONSE')) {
        return error instanceof Error ? error : new Error(String(error));
    }
    return new MediaError(error.code, `${error.message}; the provider may still have charged for this request, so do not retry without asking the user`, {
        ...error.status === undefined ? {} : { status: error.status }, cause: error,
    });
}
/**
 * Generate and save the images of one plan: the prompt, then each
 * variation, one provider call each. A failure after an image was saved
 * stops the rest and is reported with what was saved.
 * @param prompt - the text sent to the model, unchanged.
 */
export async function runImagePlan(ctx, service, config, plan, prompt, caller) {
    const cwd = await workingDirectory(ctx, caller);
    const dir = resolveOutputDir(cwd, config.outputDir);
    // Inputs are read before the request, so a missing file fails before anything is billed.
    const inputs = await loadInputImages(plan.inputs, cwd);
    const attachments = ctx.get('attachments');
    const saved = [];
    let attachmentFailures = 0;
    let costUsd = 0;
    let failed;
    const index = config.mediaFiles === undefined ? undefined : await config.mediaFiles;
    const total = 1 + plan.variations.length;
    for (const [n, text] of [prompt, ...plan.variations].entries()) {
        try {
            const result = await service.generate(plan, text, caller.signal, inputs);
            // A response arrived, so this request is billed even if saving fails.
            costUsd = costUsd === null || result.costUsd === null ? null : costUsd + result.costUsd;
            const batch = await saveImages(result.images.map(i => i.data), {
                dir, model: plan.model.id, attachments, maxBytes: config.maxImageBytes,
            });
            saved.push(...batch.saved);
            attachmentFailures += batch.attachmentFailures;
            // Index at once, so images saved before a later failure still show in the chat.
            // The images are saved either way; a failed entry only hides them from the chat view.
            if (index !== undefined)
                await Promise.all(batch.saved.map(i => index.add(i.path, { mediaType: i.mediaType, bytes: i.bytes }).catch(() => { })));
        }
        catch (error) {
            if (saved.length === 0)
                throw maybeCharged(error);
            failed = `image ${n + 1} of ${total} failed: ${maybeCharged(error).message}`;
            break;
        }
    }
    return {
        provider: plan.provider.id,
        model: plan.model.id,
        images: saved.map(s => ({
            path: s.path,
            mediaType: s.mediaType,
            bytes: s.bytes,
            ...s.attachment === undefined ? {} : { attachment: s.attachment },
        })),
        costUsd,
        staleCatalog: plan.staleCatalog,
        attachmentFailures,
        ...failed === undefined ? {} : { failed },
    };
}
/**
 * Submit one planned video job and hand it to the watcher.
 * @param prompt - the text sent to the model, unchanged.
 * @param origin - who asked: the agent's tool call or the user's command.
 */
export async function startVideoPlan(ctx, service, config, plan, prompt, caller, origin) {
    const cwd = await workingDirectory(ctx, caller);
    const dir = resolveOutputDir(cwd, config.outputDir);
    const watcher = await config.videoJobs;
    const inputs = {
        ...plan.inputs.first === undefined ? {} : { first: await loadInputImage(plan.inputs.first, cwd) },
        ...plan.inputs.last === undefined ? {} : { last: await loadInputImage(plan.inputs.last, cwd) },
        references: await loadInputImages(plan.inputs.references, cwd),
    };
    const state = await service.submitVideo(plan, prompt, caller.signal, inputs);
    const now = new Date();
    const estimate = service.estimateVideo(plan);
    const sessionId = sessionIdOf(caller);
    const record = {
        id: state.id,
        providerId: plan.provider.id,
        model: plan.model.id,
        modelName: plan.model.name,
        prompt: prompt.slice(0, PROMPT_EXCERPT),
        params: plan.params,
        ...sessionId === undefined ? {} : { sessionId },
        origin,
        dir,
        status: state.status,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        watchUntil: new Date(now.getTime() + config.maxWatchMs()).toISOString(),
        ...estimate === undefined ? {} : { estimate },
        outputs: state.outputs,
        files: [],
        delivered: false,
        failures: 0,
    };
    // The job is already billed at the provider, so a storage failure must not hide its id.
    try {
        await watcher.add(record);
    }
    catch (error) {
        return { ...record, status: 'stopped', error: `the job could not be recorded for watching: ${String(error)}` };
    }
    return record;
}
