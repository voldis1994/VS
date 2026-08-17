/**
 * Supervisor orchestrator — probes real dependencies; never fakes READY.
 */
import { type SupervisorSnapshot } from './state.js';
export type ProbeFns = {
    checkPostgres?: () => Promise<boolean>;
    checkRedis?: () => Promise<boolean>;
    checkControlApi?: () => Promise<boolean>;
    checkWireguard?: () => Promise<'READY' | 'DEGRADED' | 'FAILED' | 'STOPPED'>;
};
/**
 * Evaluate current host/runtime into a supervisor snapshot.
 * Trading stays fail-closed unless every gate is explicitly true.
 */
export declare function evaluateSupervisor(probes?: ProbeFns): Promise<SupervisorSnapshot>;
