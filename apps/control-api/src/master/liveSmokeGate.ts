/**
 * Gate for master:live-smoke / verify live_capital_network.
 * LIVE credentials may come from CAPITAL_* env OR Brokers-page DB — same as
 * resolveBrokerFromEnv / Start LIVE. Skipping only on missing env would falsely
 * block proving live_capital_network when operators use Brokers-only keys.
 */
import type { EnvBrokerResult } from './envBroker.js';

export type LiveSmokeGate =
  | { action: 'proceed'; credentialSource: 'env' | 'desk' | 'unknown' }
  | { action: 'skip'; detail: string }
  | { action: 'fail'; detail: string };

const MISSING_CREDS =
  /live_requested_but_CAPITAL_|desk_capital_no_enabled|desk_capital_connection_missing|desk_capital_creds_incomplete|desk_db_unavailable|desk_not_capital_com|desk_capital_disabled|paper_default/i;

export function credentialSourceFromDetail(detail: string): 'env' | 'desk' | 'unknown' {
  if (/capital_env_connected/i.test(detail)) return 'env';
  if (/capital_desk_connected/i.test(detail)) return 'desk';
  return 'unknown';
}

/** Classify resolveBrokerFromEnv result for smoke honesty (no network). */
export function classifyLiveSmokeBroker(resolved: EnvBrokerResult): LiveSmokeGate {
  if (resolved.broker.name === 'CAPITAL' && resolved.mode === 'LIVE') {
    if (!resolved.ok) {
      return { action: 'fail', detail: resolved.detail };
    }
    return {
      action: 'proceed',
      credentialSource: credentialSourceFromDetail(resolved.detail),
    };
  }
  if (MISSING_CREDS.test(resolved.detail)) {
    return {
      action: 'skip',
      detail:
        'CAPITAL_* env missing and Brokers DB Capital credentials unavailable — cannot prove live Capital network path',
    };
  }
  return { action: 'fail', detail: resolved.detail || 'expected CAPITAL LIVE broker' };
}
