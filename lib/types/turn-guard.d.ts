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
    readonly source?: {
        readonly kind?: unknown;
    } | undefined;
}
/** Per-agent request tracking; agents are held weakly. */
export declare class TurnGuard {
    private readonly requests;
    private readonly generated;
    /**
     * Record the messages that enter an agent's step. A message the user sent
     * starts a new request; notices and tool results continue the current one.
     */
    enter(agent: object | undefined, messages: readonly StepMessage[]): void;
    /**
     * Record one generation call and tell whether the agent already made one
     * since the user last wrote. Agents whose user message was never seen
     * never count as a repeat.
     */
    repeat(agent: object | undefined): boolean;
}
