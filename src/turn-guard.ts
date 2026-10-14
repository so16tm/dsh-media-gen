/**
 * TurnGuard: tells whether a generation call follows from the user's request.
 * A turn that a notice rather than the user started (a subagent's report, a
 * finished video job) asked for nothing, so a generation there is the agent
 * acting on its own and is refused. Inside a turn the user started, the agent
 * may need several calls (more images than one call takes, an image and then
 * a video); the second and later are billed beyond the first, so they are
 * always put to the user, even where the conversation allows generation
 * without asking.
 * @module dsh-media-gen/src/turn-guard
 */

/** The part of a step's message the guard reads. */
export interface StepMessage {
  readonly source?: { readonly kind?: unknown } | undefined
}

/** How a generation call relates to the current turn. */
export type TurnStanding = 'unknown' | 'unrequested' | 'first' | 'repeat'

interface TurnState {
  turn: number
  /** The user wrote in this turn. */
  requested: boolean
  /** A generation went ahead or was put to the user in this turn. */
  generated: boolean
}

/** Per-agent turn tracking; agents are held weakly. */
export class TurnGuard {
  private readonly states = new WeakMap<object, TurnState>()

  /** Record the messages that enter one step of an agent's turn. */
  enter(agent: object | undefined, turn: number, messages: readonly StepMessage[]): void {
    if (agent === undefined) return
    const user = messages.some(m => m.source?.kind === 'user')
    const state = this.states.get(agent)
    if (state === undefined || state.turn !== turn) this.states.set(agent, { turn, requested: user, generated: false })
    else if (user) state.requested = true
  }

  /** How a generation call now relates to the agent's turn; an agent never seen is unknown. */
  standing(agent: object | undefined): TurnStanding {
    const state = agent === undefined ? undefined : this.states.get(agent)
    if (state === undefined) return 'unknown'
    if (!state.requested) return 'unrequested'
    return state.generated ? 'repeat' : 'first'
  }

  /** Record a generation call that went ahead or was put to the user. */
  record(agent: object | undefined): void {
    const state = agent === undefined ? undefined : this.states.get(agent)
    if (state !== undefined) state.generated = true
  }
}
