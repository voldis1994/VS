/**
 * Spec order lifecycle state machine (section 16).
 * Separate from legacy vs-core OSM — map at integration boundary.
 */
import type { OrderLifecycleState } from './types.js';
export declare function canTransitionOrder(from: OrderLifecycleState, to: OrderLifecycleState): boolean;
export declare function transitionOrder(input: {
    from: OrderLifecycleState;
    to: OrderLifecycleState;
    reason: string;
    timestamp?: string;
    broker_response?: unknown;
}): {
    ok: true;
    state: OrderLifecycleState;
    timestamp: string;
    reason: string;
    broker_response: unknown;
} | {
    ok: false;
    reason: string;
};
