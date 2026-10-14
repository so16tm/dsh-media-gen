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
/**
 * Message sources that report something rather than ask for anything: another
 * agent's message or settling, a finished background job, and this plugin's
 * own video notices. A turn they alone start was not requested. Every other
 * source (the user, a goal round, a schedule the user set up) is a request.
 */
const NOTICE_KINDS = new Set(['agent-message', 'subagent-settled', 'tool-jobs', 'plugin:dsh-media-gen']);
/** Sources by which the user speaks in the middle of a turn. */
const USER_KINDS = new Set(['user', 'user-question-reply']);
/** Per-agent turn tracking; agents are held weakly. */
export class TurnGuard {
    states = new WeakMap();
    /** Record the messages that enter one step of an agent's turn. */
    enter(agent, turn, messages) {
        if (agent === undefined)
            return;
        const state = this.states.get(agent);
        if (state === undefined || state.turn !== turn) {
            const notice = messages.length > 0 && messages.every(m => NOTICE_KINDS.has(m.source?.kind));
            this.states.set(agent, { turn, requested: !notice, generated: false });
        }
        else if (messages.some(m => USER_KINDS.has(m.source?.kind))) {
            state.requested = true;
        }
    }
    /** How a generation call now relates to the agent's turn; an agent never seen is unknown. */
    standing(agent) {
        const state = agent === undefined ? undefined : this.states.get(agent);
        if (state === undefined)
            return 'unknown';
        if (!state.requested)
            return 'unrequested';
        return state.generated ? 'repeat' : 'first';
    }
    /** Record a generation call that went ahead or was put to the user. */
    record(agent) {
        const state = agent === undefined ? undefined : this.states.get(agent);
        if (state !== undefined)
            state.generated = true;
    }
}
