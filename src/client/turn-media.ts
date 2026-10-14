/**
 * Images one turn generated, for the reuse buttons under the turn's reply.
 * A turn-scoped Definition records the paths each successful
 * `media_generate_image` result reports in its presentation metadata, or, for
 * results saved before the plugin attached metadata, lists in its text; the
 * turn-tail entry reads them back when the turn closes.
 * @module dsh-media-gen/src/client/turn-media
 */

import { imagesOf, textOf } from './media-model.ts'

/** Turn data key. */
export const TURN_MEDIA_KEY = 'mediaGen.images'

/** Tools whose results carry generated images. */
const IMAGE_TOOLS = new Set(['media_generate_image'])

/** One generated image and the sequence of the result that saved it. */
export interface TurnImage {
  readonly seq: number
  readonly path: string
}

/** Turn data published under {@link TURN_MEDIA_KEY}. */
export interface TurnMediaData {
  readonly images: readonly TurnImage[]
  /** Summed cost of this turn's image results; null when any result did not report one. */
  readonly costUsd?: number | null
}

interface State {
  readonly turn: number
  /** Ids of this turn's image tool calls. */
  readonly calls: ReadonlySet<string>
  readonly images: readonly TurnImage[]
  readonly costUsd: number | null
}

/** The parts of a Session event this Definition reads. */
interface EventLike {
  type: string
  seq: number
  surfaceOp?: unknown
  data: {
    turn: number
    callId?: unknown
    name?: unknown
    meta?: unknown
    message?: { isError?: boolean; source?: { callId?: unknown }; content?: readonly unknown[] }
  }
}

interface Match { event: EventLike }

/** Turn-local accumulator of generated images; it publishes no view node. */
export const turnMediaDefinition = {
  kind: TURN_MEDIA_KEY,
  match: (event: EventLike) => {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' as const }
    if (event.type === 'tool/call' && typeof event.data.name === 'string' && IMAGE_TOOLS.has(event.data.name)) {
      return { id: String(event.data.turn), role: 'update' as const }
    }
    // Only the transcript's own results; replacement copies are model-only.
    if (event.type === 'tool/result' && event.surfaceOp === 'append') return { id: String(event.data.turn), role: 'update' as const }
    return null
  },
  start: (_context: unknown, match: Match): State => {
    if (match.event.type !== 'turn/start') throw new Error(`${TURN_MEDIA_KEY} start requires turn/start`)
    return { turn: match.event.data.turn, calls: new Set(), images: [], costUsd: 0 }
  },
  update: (context: { state: State }, match: Match): State => {
    const { event } = match
    const state = context.state
    if (event.type === 'tool/call') return { ...state, calls: new Set([...state.calls, String(event.data.callId)]) }
    if (event.type !== 'tool/result' || event.data.message?.isError === true) return state
    if (!state.calls.has(String(event.data.message?.source?.callId))) return state
    const paths = imagesOf(event.data.meta, textOf(event.data.message?.content))
    if (paths.length === 0) return state
    const cost = (event.data.meta as { costUsd?: unknown } | null | undefined)?.costUsd
    return {
      ...state,
      images: [...state.images, ...paths.map(path => ({ seq: event.seq, path }))],
      costUsd: state.costUsd === null || typeof cost !== 'number' ? null : state.costUsd + cost,
    }
  },
  buildLocationData: (context: { state?: State | undefined }, scope: string, previous: { kind: string; turn?: number; key?: string; value?: TurnMediaData } | null) => {
    const state = context.state
    if (scope !== 'turn' || state === undefined || state.images.length === 0) return null
    if (previous?.kind === 'turn' && previous.turn === state.turn && previous.key === TURN_MEDIA_KEY && previous.value?.images === state.images
      && previous.value.costUsd === state.costUsd) {
      return previous
    }
    return { kind: 'turn', turn: state.turn, key: TURN_MEDIA_KEY, value: { images: state.images, costUsd: state.costUsd } }
  },
}

/** Owner props of DSH's `conversation.chat.turnTail` slot that the entry reads. */
export interface TurnTailOwner {
  turn: { end?: { seq: number } | undefined; data: { get(key: string): unknown } }
  seq: number
  openFile(path: string): void
}

/** The turn's generated images up to its end, each path once. */
export function turnImages(owner: TurnTailOwner): string[] {
  const data = owner.turn.data.get(TURN_MEDIA_KEY) as TurnMediaData | undefined
  const bound = owner.turn.end?.seq ?? owner.seq
  return [...new Set((data?.images ?? []).filter(i => i.seq <= bound).map(i => i.path))]
}

/** The turn's summed image cost, when every result reported one. */
export function turnCost(owner: TurnTailOwner): number | undefined {
  const cost = (owner.turn.data.get(TURN_MEDIA_KEY) as TurnMediaData | undefined)?.costUsd
  return typeof cost === 'number' ? cost : undefined
}
