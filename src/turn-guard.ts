/**
 * TurnGuard: notices a second generation inside one user request. The agent
 * sometimes calls a generation tool again on its own to retry or vary a
 * result, also in a turn that a notice rather than the user started (a
 * subagent's report, a finished video job); such a call is billed, so it is
 * always put to the user, even where the conversation allows generation
 * without asking.
 * @module dsh-media-gen/src/turn-guard
 */

/** The part of a step's message the guard reads. */
export interface StepMessage {
  readonly source?: { readonly kind?: unknown } | undefined
}

/** Per-agent request tracking; agents are held weakly. */
export class TurnGuard {
  private readonly requests = new WeakMap<object, number>()
  private readonly generated = new WeakMap<object, number>()

  /**
   * Record the messages that enter an agent's step. A message the user sent
   * starts a new request; notices and tool results continue the current one.
   */
  enter(agent: object | undefined, messages: readonly StepMessage[]): void {
    if (agent === undefined || !messages.some(m => m.source?.kind === 'user')) return
    this.requests.set(agent, (this.requests.get(agent) ?? 0) + 1)
  }

  /**
   * Record one generation call and tell whether the agent already made one
   * since the user last wrote. Agents whose user message was never seen
   * never count as a repeat.
   */
  repeat(agent: object | undefined): boolean {
    if (agent === undefined) return false
    const request = this.requests.get(agent)
    if (request === undefined) return false
    const repeated = this.generated.get(agent) === request
    this.generated.set(agent, request)
    return repeated
  }
}
