/**
 * Spec order lifecycle state machine (section 16).
 * Separate from legacy vs-core OSM — map at integration boundary.
 */
const EDGES = {
    SETUP: ['ENTRY_PENDING', 'CANCELLED', 'ERROR'],
    ENTRY_PENDING: ['SUBMITTED', 'REJECTED', 'CANCELLED', 'ERROR'],
    SUBMITTED: ['ACKNOWLEDGED', 'REJECTED', 'CANCELLED', 'ERROR'],
    ACKNOWLEDGED: ['PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'ERROR'],
    PARTIALLY_FILLED: ['FILLED', 'CANCELLED', 'ERROR'],
    FILLED: ['PROTECTED', 'EXIT_PENDING', 'ERROR'],
    PROTECTED: ['MANAGING', 'EXIT_PENDING', 'ERROR'],
    MANAGING: ['EXIT_PENDING', 'PROTECTED', 'ERROR'],
    EXIT_PENDING: ['CLOSED', 'ERROR'],
    CLOSED: [],
    REJECTED: [],
    CANCELLED: [],
    ERROR: [],
};
export function canTransitionOrder(from, to) {
    return (EDGES[from] || []).includes(to);
}
export function transitionOrder(input) {
    if (!canTransitionOrder(input.from, input.to)) {
        return { ok: false, reason: `INVALID_TRANSITION ${input.from}→${input.to}` };
    }
    return {
        ok: true,
        state: input.to,
        timestamp: input.timestamp || new Date().toISOString(),
        reason: input.reason,
        broker_response: input.broker_response ?? null,
    };
}
