/**
 * SessionModels: the image and video model chosen for one session, which
 * takes precedence over the configured defaults. Choices are kept in DSH's
 * storage domain keyed by session id, so they survive a restart.
 * @module dsh-media-gen/src/session-models
 */

import { MediaError } from './errors.ts'
import type { MediaService } from './service.ts'
import { openDomain, type DomainSpecLike, type DomainTable, type StorageDomainService } from './storage.ts'

/** What a model generates. */
export type MediaKind = 'image' | 'video'

/** One chosen model, with the provider it was chosen from. */
export interface ModelChoice {
  model: string
  provider?: string
}

/** Choices of one session. */
export interface SessionModels {
  image?: ModelChoice
  video?: ModelChoice
  updatedAt: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseChoice(raw: unknown, kind: string): ModelChoice | undefined {
  if (raw === undefined) return undefined
  if (!isRecord(raw) || typeof raw.model !== 'string' || (raw.provider !== undefined && typeof raw.provider !== 'string')) {
    throw new Error(`session ${kind} model must be { model, provider? }`)
  }
  return raw as unknown as ModelChoice
}

/** Validator for stored session choices. */
export const sessionModelsSchema = {
  parse(raw: unknown): SessionModels {
    if (!isRecord(raw) || typeof raw.updatedAt !== 'string') throw new Error('session models must carry updatedAt')
    parseChoice(raw.image, 'image')
    parseChoice(raw.video, 'video')
    return raw as unknown as SessionModels
  },
}

/** Storage-domain declaration of the session choices. */
export const SESSION_MODELS_DOMAIN = {
  name: 'media_gen_session',
  version: 1,
  tables: { models: { valueSchema: sessionModelsSchema } },
} as const satisfies DomainSpecLike

/** Persistence of per-session choices. */
export interface SessionModelStore {
  get(sessionId: string): SessionModels | undefined
  /** Set or, with undefined, clear one kind's choice. */
  set(sessionId: string, kind: MediaKind, choice: ModelChoice | undefined): Promise<void>
  readonly durable: boolean
  close?(): Promise<void>
}

function nextValue(current: SessionModels | undefined, kind: MediaKind, choice: ModelChoice | undefined, now: Date): SessionModels | undefined {
  const next: SessionModels = { ...current, updatedAt: now.toISOString() }
  if (choice === undefined) delete next[kind]
  else next[kind] = choice
  return next.image === undefined && next.video === undefined ? undefined : next
}

/** Process-local store used when DSH offers no storage domain. */
export class MemorySessionModelStore implements SessionModelStore {
  readonly durable = false
  private readonly rows = new Map<string, SessionModels>()
  constructor(private readonly now: () => Date = () => new Date()) {}
  get(sessionId: string): SessionModels | undefined { return this.rows.get(sessionId) }
  async set(sessionId: string, kind: MediaKind, choice: ModelChoice | undefined): Promise<void> {
    const next = nextValue(this.rows.get(sessionId), kind, choice, this.now())
    if (next === undefined) this.rows.delete(sessionId)
    else this.rows.set(sessionId, next)
  }
}

/** Open the durable store of session choices. */
export async function openSessionModelStore(service: StorageDomainService, attempts?: number, delayMs?: number): Promise<SessionModelStore> {
  const domain = await openDomain(service, SESSION_MODELS_DOMAIN, attempts, delayMs)
  const table = domain.table('models') as DomainTable<SessionModels>
  return {
    durable: true,
    get: sessionId => table.get(sessionId),
    async set(sessionId, kind, choice) {
      const next = nextValue(table.get(sessionId), kind, choice, new Date())
      if (next === undefined) await table.delete(sessionId)
      else await table.put(sessionId, next)
    },
    close: () => domain.close(),
  }
}

/** Command name, without the slash. */
export const MEDIA_MODEL_COMMAND = 'media-model'

const USAGE = `usage: /${MEDIA_MODEL_COMMAND} image|video <model-id> [provider] · /${MEDIA_MODEL_COMMAND} image|video default`

/** Outcome of one `/media-model` invocation. */
export type CommandOutcome = { kind: 'success'; text: string } | { kind: 'error'; text: string }

/**
 * Run `/media-model` for one session. A bare command reports the current
 * choices; `image` or `video` alone lists the ids it accepts; with an id it
 * checks the id against the provider's listing before saving it.
 * @param store - session choices.
 * @param service - model listings and configured defaults.
 * @param sessionId - the calling session.
 * @param rawInput - text after the command name.
 */
export async function runMediaModelCommand(
  store: SessionModelStore,
  service: MediaService,
  sessionId: string,
  rawInput: string,
  signal?: AbortSignal,
): Promise<CommandOutcome> {
  const [kindArg, modelArg, providerArg, ...rest] = rawInput.trim().split(/\s+/u).filter(part => part.length > 0)
  const settings = service.settings()
  const describe = (kind: MediaKind): string => {
    const chosen = store.get(sessionId)?.[kind]
    const fallback = kind === 'image' ? settings.defaultImageModel : settings.defaultVideoModel
    if (chosen !== undefined) return `${kind}: ${chosen.model} (this session)`
    return fallback === undefined ? `${kind}: not set` : `${kind}: ${fallback} (default)`
  }
  if (kindArg === undefined) return { kind: 'success', text: `${describe('image')} · ${describe('video')} · ${USAGE}` }
  if (kindArg !== 'image' && kindArg !== 'video') return { kind: 'error', text: `unknown kind "${kindArg}"; ${USAGE}` }
  if (rest.length > 0) return { kind: 'error', text: USAGE }
  const kind: MediaKind = kindArg
  try {
    if (modelArg === undefined) {
      const provider = service.bridge.pick()
      const ids = await listIds(service, kind, provider, signal)
      return { kind: 'success', text: `${describe(kind)} · ${ids.length} ${kind} models on ${provider.id}: ${ids.join(', ')}` }
    }
    if (modelArg === 'default' || modelArg === 'reset') {
      await store.set(sessionId, kind, undefined)
      return { kind: 'success', text: `${kind} model for this session cleared; ${describe(kind)}` }
    }
    const provider = service.bridge.pick(providerArg)
    const ids = await listIds(service, kind, provider, signal)
    if (!ids.includes(modelArg)) {
      return { kind: 'error', text: `${provider.id} lists no ${kind} model "${modelArg}"; run /${MEDIA_MODEL_COMMAND} ${kind} to see the ids` }
    }
    await store.set(sessionId, kind, { model: modelArg, ...providerArg === undefined ? {} : { provider: provider.id } })
    return { kind: 'success', text: `${kind} model for this session: ${modelArg} (${provider.id})` }
  } catch (error) {
    return { kind: 'error', text: error instanceof MediaError ? error.message : String(error) }
  }
}

async function listIds(service: MediaService, kind: MediaKind, provider: ReturnType<MediaService['bridge']['pick']>, signal?: AbortSignal): Promise<string[]> {
  const options = signal === undefined ? {} : { signal }
  const snapshot = kind === 'image' ? await service.imageModels(provider, options) : await service.videoModels(provider, options)
  return snapshot.models.map(model => model.id)
}

/**
 * Fill in the session's choice when a call names no model.
 * @param args - tool arguments.
 * @param choice - the session's choice for this kind, if any.
 */
export function withSessionModel<A extends { model?: string | undefined; provider?: string | undefined }>(args: A, choice: ModelChoice | undefined): A {
  if (args.model !== undefined || choice === undefined) return args
  return { ...args, model: choice.model, ...args.provider === undefined && choice.provider !== undefined ? { provider: choice.provider } : {} }
}
