/**
 * Canonical public API for supervisor.
 * Explicit named re-exports — avoid `export *` under tsx/Node ESM.
 */

export type { SubsystemState, SubsystemName, SubsystemStatus, SupervisorSnapshot } from './state.js';
export {
  BOOT_ORDER,
  createInitialRegistry,
  setSubsystem,
  evaluateTradingReady,
  evaluateProcessReady,
  snapshot,
} from './state.js';

export type { ProbeFns } from './orchestrator.js';
export { evaluateSupervisor } from './orchestrator.js';

export type {
  ReadyFlag,
  Probe,
  SupervisorSnapshot as ReadinessSupervisorSnapshot,
} from './readiness.js';
export { computeSupervisor } from './readiness.js';
