/**
 * TurnGuard: notices a second generation inside one agent turn. The agent
 * sometimes calls a generation tool again on its own to retry or vary a
 * result; such a call is billed, so it is always put to the user, even where
 * the conversation allows generation without asking.
 * @module dsh-media-gen/src/turn-guard
 */
/** Per-agent turn tracking; agents are held weakly. */
export declare class TurnGuard {
    private readonly turns;
    private readonly generated;
    /** Record the turn an agent's step belongs to. */
    enter(agent: object | undefined, turn: number): void;
    /**
     * Record one generation call and tell whether the agent already made one
     * in its current turn. Unknown agents or turns never count as a repeat.
     */
    repeat(agent: object | undefined): boolean;
}
