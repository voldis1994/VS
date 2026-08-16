/**
 * Canonical public API for execution.
 * Explicit named re-exports — avoid `export *` under tsx/Node ESM.
 */

export type { OrderState } from './orderStateMachine.js';
export { canTransition, transition } from './orderStateMachine.js';
