/**
 * TurnGuard: tells whether a generation call follows from a request. A turn
 * that only a notice started (a subagent's report, a finished job) asked for
 * nothing, so a generation there is the agent
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
export type TurnStanding = 'unknown' | 'unrequested' | 'delegated' | 'first' | 'repeat'

interface TurnState {
  turn: number
  /** Something other than a notice started this turn, or the user wrote in it. */
  requested: boolean
  /** A generation went ahead or was put to the user in this turn. */
  generated: boolean
}

/**
 * Message sources that report something rather than ask for anything: another
 * agent's message or settling, a finished background job, and this plugin's
 * own video notices. A turn they alone start was not requested. Every other
 * source (the user, a goal round, a schedule the user set up) is a request.
 */
const NOTICE_KINDS: ReadonlySet<unknown> = new Set(['agent-message', 'subagent-settled', 'tool-jobs', 'plugin:dsh-media-gen'])

/** Sources by which the user speaks in the middle of a turn. */
const USER_KINDS: ReadonlySet<unknown> = new Set(['user', 'user-question-reply'])

/** Where a subagent's work came from: the conversation's agent and its turn when it delegated. */
interface Origin {
  root: object
  turn: number
}

/** Per-agent turn tracking; agents are held weakly. */
export class TurnGuard {
  private readonly states = new WeakMap<object, TurnState>()
  /** Turns in which an agent generated itself. */
  private readonly generatedTurns = new WeakMap<object, Set<number>>()
  /** Turns whose request an agent's subagents generate. */
  private readonly delegatedTurns = new WeakMap<object, Set<number>>()
  private readonly origins = new WeakMap<object, Origin>()

  /** Record the messages that enter one step of an agent's turn. */
  enter(agent: object | undefined, turn: number, messages: readonly StepMessage[]): void {
    if (agent === undefined) return
    const state = this.states.get(agent)
    if (state === undefined || state.turn !== turn) {
      const notice = messages.length > 0 && messages.every(m => NOTICE_KINDS.has(m.source?.kind))
      this.states.set(agent, { turn, requested: !notice, generated: false })
    } else if (messages.some(m => USER_KINDS.has(m.source?.kind))) {
      state.requested = true
    }
  }

  /**
   * How a generation call now relates to the agent's turn; an agent never
   * seen is unknown. A turn whose request a subagent already generates is
   * delegated: the agent does not generate it a second time itself.
   */
  standing(agent: object | undefined): TurnStanding {
    const state = agent === undefined ? undefined : this.states.get(agent)
    if (state === undefined) return 'unknown'
    if (!state.requested) return 'unrequested'
    if (this.delegatedTurns.get(agent!)?.has(state.turn) === true) return 'delegated'
    return state.generated ? 'repeat' : 'first'
  }

  /** Record a generation call that went ahead or was put to the user. */
  record(agent: object | undefined): void {
    const state = agent === undefined ? undefined : this.states.get(agent)
    if (state === undefined) return
    state.generated = true
    add(this.generatedTurns, agent!, state.turn)
  }

  /**
   * Remember, once, the conversation's agent and its current turn as the
   * origin of a subagent's work. Called when the subagent starts, which is
   * inside the turn that delegated to it.
   */
  adopt(child: object, root: object | undefined): void {
    if (root === undefined || this.origins.has(child)) return
    const state = this.states.get(root)
    if (state !== undefined) this.origins.set(child, { root, turn: state.turn })
  }

  /** Whether the agent that delegated to this subagent already generated the same request itself. */
  duplicate(child: object | undefined): boolean {
    const origin = child === undefined ? undefined : this.origins.get(child)
    return origin !== undefined && this.generatedTurns.get(origin.root)?.has(origin.turn) === true
  }

  /** Record that a subagent generates the request of the turn that delegated to it. */
  recordDelegated(child: object | undefined): void {
    const origin = child === undefined ? undefined : this.origins.get(child)
    if (origin !== undefined) add(this.delegatedTurns, origin.root, origin.turn)
  }
}

function add(map: WeakMap<object, Set<number>>, key: object, turn: number): void {
  const turns = map.get(key) ?? new Set<number>()
  turns.add(turn)
  map.set(key, turns)
}
