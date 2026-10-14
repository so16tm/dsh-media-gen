/**
 * Direct generation: `/image` and `/video` send the user's own prompt to the
 * chosen model without going through the agent. Options come first and the
 * rest of the line is the prompt, sent unchanged. While approval is on, a
 * command without `--yes` only shows the estimate, so typing the line again
 * with `--yes` is the approval.
 * @module dsh-media-gen/src/direct
 */
import { MediaError } from "./errors.js";
import { runImagePlan, sessionIdOf, startVideoPlan } from "./generate.js";
import { describeJob } from "./jobs.js";
import { formatCost, formatCostRange } from "./messages.js";
import { videoInputCount } from "./service.js";
import { withSessionModel } from "./session-models.js";
/** Command names, without the slash. */
export const IMAGE_COMMAND = 'image';
export const VIDEO_COMMAND = 'video';
/** Command input hints. */
export const IMAGE_HINT = '[--model id] [--aspect 1:1] [--resolution 1K] [--count n] [--seed n] [--image path]... [--yes] <prompt>';
export const VIDEO_HINT = '[--model id] [--duration s] [--aspect 16:9] [--resolution 720p] [--audio on|off] [--seed n] '
    + '[--first path] [--last path] [--ref path]... [--yes] <prompt>';
const IMAGE_OPTIONS = new Set(['model', 'provider', 'aspect', 'resolution', 'count', 'seed', 'image']);
const VIDEO_OPTIONS = new Set(['model', 'provider', 'aspect', 'resolution', 'duration', 'audio', 'seed', 'first', 'last', 'ref']);
/** Options that may be given more than once. */
const REPEATABLE = new Set(['image', 'ref']);
function integer(name, value) {
    if (!/^\d+$/u.test(value))
        throw new MediaError('INVALID_REQUEST', `--${name} takes a whole number; got ${value}`);
    return Number(value);
}
/** Parsed options; repeatable ones keep every value. */
class Options {
    values;
    constructor(values) {
        this.values = values;
    }
    get(name) { return this.values.get(name)?.[0]; }
    all(name) { return this.values.get(name); }
}
/**
 * Split leading `--name value` options and `--yes` from the prompt. A value
 * with spaces, such as a path, is written in double quotes.
 * @param allowed - option names this command accepts.
 * @param rawInput - text after the command name.
 */
function split(allowed, rawInput) {
    const values = new Map();
    let confirmed = false;
    let rest = rawInput.trimStart();
    for (;;) {
        const flag = /^--([a-z]+)(?:\s+|$)/u.exec(rest);
        if (flag === null)
            break;
        const name = flag[1];
        rest = rest.slice(flag[0].length);
        if (name === 'yes') {
            confirmed = true;
            continue;
        }
        if (!allowed.has(name))
            throw new MediaError('INVALID_REQUEST', `unknown option --${name}`);
        const value = /^(?:"([^"]*)"|(\S+))(?:\s+|$)/u.exec(rest);
        if (value === null)
            throw new MediaError('INVALID_REQUEST', `--${name} needs a value`);
        const previous = values.get(name);
        if (previous !== undefined && !REPEATABLE.has(name))
            throw new MediaError('INVALID_REQUEST', `--${name} is given twice`);
        values.set(name, [...previous ?? [], value[1] ?? value[2]]);
        rest = rest.slice(value[0].length);
    }
    const prompt = rest.trim();
    if (prompt.length === 0)
        throw new MediaError('INVALID_REQUEST', 'write the prompt after the options');
    return { options: new Options(values), confirmed, prompt };
}
/** Parse an `/image` line. */
export function parseImageCommand(rawInput) {
    const { options, confirmed, prompt } = split(IMAGE_OPTIONS, rawInput);
    const count = options.get('count');
    const seed = options.get('seed');
    return {
        confirmed,
        args: {
            prompt,
            model: options.get('model'),
            provider: options.get('provider'),
            aspect_ratio: options.get('aspect'),
            resolution: options.get('resolution'),
            count: count === undefined ? undefined : integer('count', count),
            seed: seed === undefined ? undefined : integer('seed', seed),
            input_images: options.all('image'),
        },
    };
}
/** Parse a `/video` line. */
export function parseVideoCommand(rawInput) {
    const { options, confirmed, prompt } = split(VIDEO_OPTIONS, rawInput);
    const duration = options.get('duration');
    const seed = options.get('seed');
    const audio = options.get('audio');
    if (audio !== undefined && audio !== 'on' && audio !== 'off')
        throw new MediaError('INVALID_REQUEST', '--audio takes on or off');
    return {
        confirmed,
        args: {
            prompt,
            model: options.get('model'),
            provider: options.get('provider'),
            aspect_ratio: options.get('aspect'),
            resolution: options.get('resolution'),
            duration: duration === undefined ? undefined : integer('duration', duration),
            generate_audio: audio === undefined ? undefined : audio === 'on',
            seed: seed === undefined ? undefined : integer('seed', seed),
            first_frame: options.get('first'),
            last_frame: options.get('last'),
            reference_images: options.all('ref'),
        },
    };
}
/** Whether this command must stop at the estimate: approval is on, the line has no --yes, and the session has not allowed it. */
async function mustConfirm(deps, confirmed, caller) {
    if (!deps.requireApproval() || confirmed)
        return false;
    const sessionId = sessionIdOf(caller);
    return sessionId === undefined || (await deps.sessionModels).get(sessionId)?.autoApprove !== true;
}
async function withChoice(deps, kind, args, caller) {
    const sessionId = sessionIdOf(caller);
    return sessionId === undefined ? args : withSessionModel(args, (await deps.sessionModels).get(sessionId)?.[kind]);
}
function inputNote(count) {
    return count === 0 ? '' : ` from ${count} input image(s)`;
}
function errorText(error) {
    return error instanceof MediaError ? `${error.code}: ${error.message}` : String(error);
}
/** Run one `/image` line. Command results are English: the Host has no locale service for them. */
export async function runImageCommand(deps, rawInput, caller) {
    try {
        const { args, confirmed } = parseImageCommand(rawInput);
        const plan = await deps.service.plan(await withChoice(deps, 'image', args, caller), caller.signal);
        if (await mustConfirm(deps, confirmed, caller)) {
            const cost = await deps.service.estimate(plan, caller.signal);
            return {
                kind: 'success',
                text: `${plan.count} image(s) with ${plan.model.name} (${plan.provider.id})${inputNote(plan.inputs.length)}, estimated cost ${formatCost('en', cost)}. `
                    + `Nothing was generated; send the same line with --yes to generate.`,
            };
        }
        const value = await runImagePlan(deps.ctx, deps.service, deps.config, plan, args.prompt, caller);
        const cost = value.costUsd === null ? 'cost not reported' : `${value.costUsd} USD`;
        // One path per line, which the chat's media view reads back to show the images.
        return { kind: 'success', text: `Saved ${value.images.length} image(s) from ${value.model} (${cost}):\n${value.images.map(i => `- ${i.path}`).join('\n')}` };
    }
    catch (error) {
        return { kind: 'error', text: errorText(error) };
    }
}
/** Run one `/video` line. */
export async function runVideoCommand(deps, rawInput, caller) {
    try {
        const { args, confirmed } = parseVideoCommand(rawInput);
        const plan = await deps.service.planVideo(await withChoice(deps, 'video', args, caller), caller.signal);
        if (await mustConfirm(deps, confirmed, caller)) {
            const seconds = typeof plan.params.duration === 'number' ? `${plan.params.duration} s` : 'default length';
            return {
                kind: 'success',
                text: `Video (${seconds}) with ${plan.model.name} (${plan.provider.id})${inputNote(videoInputCount(plan.inputs))}, estimated cost ${formatCostRange('en', deps.service.estimateVideo(plan))}. `
                    + `Nothing was submitted; send the same line with --yes to start the job.`,
            };
        }
        const record = await startVideoPlan(deps.ctx, deps.service, deps.config, plan, args.prompt, caller, 'command');
        return { kind: record.status === 'stopped' ? 'error' : 'success', text: describeJob(record) };
    }
    catch (error) {
        return { kind: 'error', text: errorText(error) };
    }
}
