/**
 * MediaTools: the model-facing tools. Descriptions are English because DSH
 * sends one tool description to every model regardless of display language.
 * @module dsh-media-gen/src/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { runImagePlan, sessionIdOf, startVideoPlan, type GenerateConfig, type ImageToolValue } from './generate.ts'
import { describeJob, type VideoJobRecord } from './jobs.ts'
import type { ParameterSpec } from './openrouter.ts'
import { MAX_NOTE_CHARS, type PromptNoteStore } from './prompt-notes.ts'
import { withSessionModel, type MediaKind, type SessionModelStore } from './session-models.ts'
import type { ImageArgs, MediaService } from './service.ts'

/** Wire names of the tools; stable across languages. */
export const TOOL_LIST_MODELS = 'media_list_models'
export const TOOL_GENERATE_IMAGE = 'media_generate_image'
export const TOOL_GENERATE_VIDEO = 'media_generate_video'
export const TOOL_VIDEO_STATUS = 'media_video_status'
export const TOOL_GET_PROMPT_NOTES = 'media_get_prompt_notes'
export const TOOL_SET_PROMPT_NOTES = 'media_set_prompt_notes'

/** How the model-facing prompt is written; shared by both generation tools. */
const PROMPT_GUIDE = 'Write the prompt for the chosen model from what the user wants: follow the model\'s promptNotes from '
  + 'media_list_models (language, sentences or tags, length) and decide yourself whether to translate, expand, or restructure '
  + 'the user\'s wording. Keep text the user wants shown in the output exactly as given. The user sees the final prompt '
  + 'before anything is billed.'

/** Which model to use; shared by both generation tools. */
const MODEL_GUIDE = 'Omit model to use the model the user selected; the selection can change between calls, so do not repeat an id '
  + 'from earlier in the conversation. A model chosen for this session in the chat input always wins over model. Pass model '
  + 'only when the user names one and selected.by is not "session"; if the user names another model while a session choice '
  + 'exists, tell them to switch it in the chat input\'s Media menu or with /media-model. Never switch on your own to a model you prefer.'

/** When details are missing; shared by both generation tools. */
/** Generation is billed, so a finished call is never followed by another on the agent's own judgment. */
const ONCE_GUIDE = 'Make only the generations the user asked for, in one call: prompts holds one complete prompt per image, '
  + 'so three images means three prompts, each describing one image only. '
  + 'Once you have what you need, call the tool in the same turn instead of announcing it and stopping. Never make more than asked. Once '
  + 'those return, do not call again on your own to retry, improve, fix, or vary the results, even if they miss the request: '
  + 'show them, say what differs, and let the user decide. Never hand a request you are generating yourself to a '
  + 'subagent as well. Delegate generation only for bulk work the user asked for, and only when generation is allowed in this '
  + 'conversation without asking: a subagent cannot ask the user, so otherwise its calls are refused. A notice that arrives afterwards, such as a subagent\'s report, '
  + 'is not a request to generate.'

const ASK_GUIDE = 'Ask only when the request leaves out something essential that you cannot reasonably choose (%s), '
  + 'and then ask once, all in one question, with ask_user_question when available. Details the user left open, such as '
  + 'which poses or a fitting style, are yours to choose: choose them and say what you chose.'

/**
 * The image tool's arguments as a plan request: the first prompt, then one
 * variation per further prompt. The tool has no count, so every image has
 * its own prompt.
 */
export function imageToolArgs<A extends { prompts?: readonly string[] | undefined }>(args: A): Omit<A, 'prompts'> & ImageArgs {
  const { prompts, ...rest } = args
  const list = (prompts ?? []).map(p => p.trim()).filter(p => p.length > 0)
  return { ...rest, prompt: list[0] ?? '', variations: list.slice(1) } as Omit<A, 'prompts'> & ImageArgs
}

/** Most jobs one status listing shows. */
const STATUS_LIMIT = 20

export { sessionIdOf, type ImageToolValue } from './generate.ts'

/** The schema's ceiling on images per call. */
const MAX_IMAGES_PER_CALL = 10

/** Settings and stores the tools need. */
export interface ToolConfig extends GenerateConfig {
  /** Per-request timeout for provider calls. */
  requestTimeoutMs: number
  /** Per-session model choices, ready once their storage has opened. */
  sessionModels: Promise<SessionModelStore>
  /** Prompt-writing notes by model id, ready once their storage has opened. */
  promptNotes: Promise<PromptNoteStore>
}

/**
 * Apply the session's model choice. The choice made in the chat input wins
 * over a model the agent names, because the agent may repeat an id from
 * earlier in the conversation after the user switched; the agent's model
 * applies only while the session has no choice.
 * @param store - session choices.
 * @param exec - the tool call, whose agent identifies the session.
 */
export async function sessionArgs<A extends { model?: string | undefined; provider?: string | undefined }>(
  store: Promise<SessionModelStore>, kind: MediaKind, args: A, exec: Pick<ToolExecution, 'agent'>,
): Promise<A> {
  const sessionId = sessionIdOf(exec)
  const choice = sessionId === undefined ? undefined : (await store).get(sessionId)?.[kind]
  if (choice === undefined || choice.model === args.model) return withSessionModel(args, choice)
  const { model: _model, provider: _provider, ...rest } = args
  return withSessionModel({ ...rest, ...choice.provider === undefined && args.provider !== undefined ? { provider: args.provider } : {} } as A, choice)
}

function describeSpec(spec: ParameterSpec): string {
  switch (spec.kind) {
    case 'enum': return spec.values.join('|')
    case 'range': return `${spec.min ?? ''}..${spec.max ?? ''}`
    case 'boolean': return 'true|false'
    case 'any': return 'any'
  }
}

/**
 * Register the media tools.
 * @param ctx - plugin context.
 * @param service - shared media service.
 * @param config - output settings.
 */
export function registerTools(ctx: Context, service: MediaService, config: ToolConfig): void {
  ctx.tools.register(defineTool({
    name: TOOL_LIST_MODELS,
    description: 'List the image or video generation models available through the providers configured in DeepSeek Harness, '
      + 'with the parameters each model accepts and any promptNotes saved for it, and report which model the user selected '
      + '(selected.model, chosen for this session or in the settings). Call this before media_generate_image or '
      + 'media_generate_video to learn how to write the prompt for the selected model.',
    parameters: {
      kind: { type: 'string', enum: ['image', 'video'], description: 'Which models to list (default image).' },
      provider: { type: 'string', description: 'DSH provider id; omit to list every media-capable provider.' },
      refresh: { type: 'boolean', description: 'Bypass the cached listing.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const providers = args.provider === undefined ? service.bridge.listProviders() : [service.bridge.pick(args.provider)]
      if (providers.length === 0) service.bridge.pick()
      const options = { refresh: args.refresh === true, signal: exec.signal }
      const settings = service.settings()
      const kind: MediaKind = args.kind === 'video' ? 'video' : 'image'
      const sessionId = sessionIdOf(exec)
      const chosen = sessionId === undefined ? undefined : (await config.sessionModels).get(sessionId)?.[kind]
      const fallback = kind === 'image' ? settings.defaultImageModel : settings.defaultVideoModel
      // The user's selection, so the agent does not pick a model on its own.
      const selected = chosen !== undefined
        ? { model: chosen.model, ...chosen.provider === undefined ? {} : { provider: chosen.provider }, by: 'session' }
        : fallback === undefined ? null : { model: fallback, by: 'settings' }
      const notes = await config.promptNotes
      const noted = (id: string) => { const note = notes.get(id); return note === undefined ? {} : { promptNotes: note.notes } }
      if (args.kind === 'video') {
        const out = []
        for (const provider of providers) {
          const snapshot = await service.videoModels(provider, options)
          out.push({
            provider: provider.id,
            name: provider.name,
            stale: snapshot.stale,
            videoModels: snapshot.models.map(m => ({
              id: m.id,
              name: m.name,
              ...m.description === undefined ? {} : { description: m.description.slice(0, 300) },
              ...m.durations === undefined ? {} : { durations: [...m.durations] },
              ...m.resolutions === undefined ? {} : { resolutions: [...m.resolutions] },
              ...m.aspectRatios === undefined ? {} : { aspectRatios: [...m.aspectRatios] },
              ...m.audio === undefined ? {} : { audio: m.audio },
              ...m.seed === undefined ? {} : { seed: m.seed },
              ...m.frameImages === undefined ? {} : { frameImages: [...m.frameImages] },
              pricingUsd: { ...m.pricingSkus },
              ...noted(m.id),
            })),
          })
        }
        return {
          selected,
          providers: out,
          defaults: { provider: settings.defaultVideoProvider ?? null, videoModel: settings.defaultVideoModel ?? null },
          limits: { maxVideoSeconds: settings.maxVideoSeconds },
        }
      }
      const out = []
      for (const provider of providers) {
        const snapshot = await service.imageModels(provider, options)
        out.push({
          provider: provider.id,
          name: provider.name,
          stale: snapshot.stale,
          imageModels: snapshot.models.map(m => ({
            id: m.id,
            name: m.name,
            ...m.description === undefined ? {} : { description: m.description.slice(0, 300) },
            ...m.inputModalities.length === 0 ? {} : { inputImages: m.inputModalities.includes('image') },
            parameters: Object.fromEntries(Object.entries(m.parameters).map(([k, v]) => [k, describeSpec(v)])),
            ...noted(m.id),
          })),
        })
      }
      return {
        selected,
        providers: out,
        defaults: { provider: settings.defaultImageProvider ?? null, imageModel: settings.defaultImageModel ?? null },
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: TOOL_GENERATE_IMAGE,
    description: 'Generate images from a text prompt with an image model of a configured provider. '
      + 'The images are saved under the working directory and shown to the user; each call may cost money, '
      + 'so do not call it repeatedly without the user asking. Use media_list_models to find model ids and the '
      + 'aspect_ratio/resolution values a model accepts. ' + MODEL_GUIDE + ' ' + PROMPT_GUIDE + ' ' + ONCE_GUIDE + ' '
      + ASK_GUIDE.replace('%s', 'subject, aspect ratio'),
    parameters: {
      prompts: {
        type: 'array', items: { type: 'string' }, required: true,
        description: 'One prompt per image, written for the model as described above; the call makes exactly this many images, '
          + 'one request each. Each prompt describes a single image (one pose, angle, or scene) and never the others: a prompt '
          + 'describing several images is refused when more than one image is asked for.',
      },
      model: { type: 'string', description: 'Image model id; omit to use the model the user selected. A model chosen for this session in the chat input overrides it.' },
      provider: { type: 'string', description: 'DSH provider id; needed only when several are configured.' },
      aspect_ratio: { type: 'string', description: 'Aspect ratio such as 1:1 or 16:9, if the model accepts it.' },
      resolution: { type: 'string', description: 'Resolution tier such as 1K or 2K, if the model accepts it.' },
      seed: { type: 'integer', description: 'Seed for reproducible output, if the model accepts it.' },
      input_images: {
        type: 'array', items: { type: 'string' },
        description: 'Reference images to edit or build on: file paths, relative to the working directory or absolute, '
          + 'such as the path of an image generated earlier or attached by the user. Only for models whose listing shows inputImages true.',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderImageResult(value as unknown as ImageToolValue),
      // The chat's media view shows the saved files from this; the model never sees it.
      presentationMeta: (_args, value) => {
        const result = value as unknown as ImageToolValue
        return {
          model: result.model, costUsd: result.costUsd, images: result.images.map(i => ({ path: i.path, mediaType: i.mediaType })),
        }
      },
    },
    // Up to the most images one call may make, each waiting its own request timeout.
    timeoutMs: MAX_IMAGES_PER_CALL * config.requestTimeoutMs + 60_000,
    async execute(args, exec) {
      const image = imageToolArgs(args)
      const plan = await service.plan(await sessionArgs(config.sessionModels, 'image', image, exec), exec.signal)
      return await runImagePlan(ctx, service, config, plan, image.prompt, exec) as never
    },
  }))

  ctx.tools.register(defineTool({
    name: TOOL_GENERATE_VIDEO,
    description: 'Start generating a video from a text prompt with a video model of a configured provider. '
      + 'Generation runs in the background and can take minutes; this returns a job id at once, and the session is '
      + 'notified when the video is saved under the working directory. Each call may cost money, so do not call it '
      + 'repeatedly without the user asking, and do not poll the job. Use media_list_models with kind "video" to find '
      + 'model ids and the durations, resolutions, and aspect ratios a model accepts. ' + MODEL_GUIDE + ' ' + PROMPT_GUIDE + ' ' + ONCE_GUIDE + ' '
      + ASK_GUIDE.replace('%s', 'subject, length, aspect ratio, whether to include audio'),
    parameters: {
      prompt: { type: 'string', required: true, description: 'The prompt sent to the video model, written for that model as described above.' },
      model: { type: 'string', description: 'Video model id; omit to use the model the user selected. A model chosen for this session in the chat input overrides it.' },
      provider: { type: 'string', description: 'DSH provider id; needed only when several are configured.' },
      duration: { type: 'integer', description: 'Length in seconds, one the model lists.' },
      resolution: { type: 'string', description: 'Resolution such as 720p or 1080p, if the model lists it.' },
      aspect_ratio: { type: 'string', description: 'Aspect ratio such as 16:9, if the model lists it.' },
      generate_audio: { type: 'boolean', description: 'Generate an audio track, if the model can.' },
      seed: { type: 'integer', description: 'Seed for reproducible output, if the model supports it.' },
      first_frame: {
        type: 'string',
        description: 'Image path used as the first frame (image to video), such as an image generated earlier. '
          + 'Only for models whose listing has "first_frame" in frameImages.',
      },
      last_frame: { type: 'string', description: 'Image path used as the last frame, if the model lists "last_frame" in frameImages.' },
      reference_images: {
        type: 'array', items: { type: 'string' },
        description: 'Reference image paths for style or subject, if the model takes them. Some models bill per input image.',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: describeJob(value as unknown as VideoJobRecord) }],
      presentationMeta: (_args, value) => {
        const job = value as unknown as VideoJobRecord
        return { jobId: job.id, model: job.modelName }
      },
    },
    async execute(args, exec) {
      const plan = await service.planVideo(await sessionArgs(config.sessionModels, 'video', args, exec), exec.signal)
      return await startVideoPlan(ctx, service, config, plan, args.prompt, exec, 'agent') as never
    },
  }))

  ctx.tools.register(defineTool({
    name: TOOL_VIDEO_STATUS,
    description: 'Show video jobs started with media_generate_video. With job_id, checks that job with the provider now '
      + '(also one whose watching stopped) and saves the video if it is finished; without it, lists this session\'s jobs. '
      + 'Finished jobs are reported automatically, so call this only when the user asks.',
    parameters: {
      job_id: { type: 'string', description: 'Job id returned by media_generate_video.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const jobs = (value as unknown as { jobs: VideoJobRecord[] }).jobs
        return [{ type: 'text', text: jobs.length === 0 ? 'No video jobs.' : jobs.map(describeJob).join('\n\n') }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const watcher = await config.videoJobs
      if (args.job_id !== undefined) return { jobs: [await watcher.check(args.job_id, exec.signal)] } as never
      const sessionId = sessionIdOf(exec)
      const jobs = watcher.store.list()
        .filter(job => sessionId === undefined || job.sessionId === sessionId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, STATUS_LIMIT)
      return { jobs } as never
    },
  }))

  ctx.tools.register(defineTool({
    name: TOOL_GET_PROMPT_NOTES,
    description: 'Read the saved prompt-writing notes, for one model or for every model that has some.',
    parameters: {
      model: { type: 'string', description: 'Model id; omit to read every saved note.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    isConcurrencySafe: () => true,
    async execute(args) {
      const notes = await config.promptNotes
      const rows = args.model === undefined ? notes.list() : [[args.model, notes.get(args.model)] as const]
      return {
        notes: rows.flatMap(([model, note]) => note === undefined ? [] : [{ model, notes: note.notes, updatedAt: note.updatedAt }]),
        durable: notes.durable,
      } as never
    },
  }))

  ctx.tools.register(defineTool({
    name: TOOL_SET_PROMPT_NOTES,
    description: 'Save prompt-writing notes for one image or video model, replacing its earlier notes; an empty text deletes them. '
      + 'Use this when the user asks to add or change how prompts for a model should be written. Keep notes short and '
      + 'practical: the language the model understands, sentences or comma-separated tags, a good length, strengths, '
      + 'things to avoid. When the notes come from documentation you looked up, say where in the notes. Read the current '
      + `notes first with ${TOOL_GET_PROMPT_NOTES} and keep what still applies.`,
    parameters: {
      model: { type: 'string', required: true, description: 'Model id as media_list_models lists it.' },
      notes: { type: 'string', required: true, description: `The complete notes, at most ${MAX_NOTE_CHARS} characters.` },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) {
      const notes = await config.promptNotes
      const saved = await notes.set(args.model, args.notes)
      return (saved === undefined
        ? { model: args.model.trim(), deleted: true, durable: notes.durable }
        : { model: args.model.trim(), notes: saved.notes, updatedAt: saved.updatedAt, durable: notes.durable }) as never
    },
  }))
}

/**
 * Model-facing rendering: a text summary plus each durable image. Text-only
 * routes receive DSH's image placeholders instead of the pixels.
 */
export function renderImageResult(value: ImageToolValue): ContentBlock[] {
  const lines = [
    `Generated ${value.images.length} image(s) with ${value.model} (provider ${value.provider}).`,
    ...value.images.map(i => `- ${i.path} (${i.mediaType}, ${i.bytes} bytes)`),
    `Cost: ${value.costUsd === null ? 'not reported' : `${value.costUsd} USD`}.`,
    'The images are already shown to the user in the chat, so do not open, read, or view the files, and do not ask '
      + 'whether to generate them. To show one again in a later reply, use Markdown such as ![short description](<path>).',
    'Do not generate beyond what the user asked for; let the user decide what to change.',
  ]
  if (value.failed !== undefined) lines.push(`Stopped early: ${value.failed}. Tell the user; do not retry on your own.`)
  if (value.attachmentFailures > 0) lines.push(`${value.attachmentFailures} image(s) could not be attached inline; the files are saved.`)
  const blocks: ContentBlock[] = [{ type: 'text', text: lines.join('\n') }]
  for (const image of value.images) {
    if (image.attachment !== undefined) blocks.push({ type: 'image', attachment: image.attachment as unknown as ImageAttachmentRef })
  }
  return blocks
}

