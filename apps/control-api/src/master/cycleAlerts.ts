/**
 * Reader-style cycle alerts — DATA_STALE / ACK_TIMEOUT / ACCOUNT_NOT_TRADEABLE.
 * Unlike Reader (alerts_affect_trading=false), MASTER can block new entries
 * when critical/error alerts are active so dead feed/bridge does not open risk.
 */
import { loadMasterErrors } from './errorJournal.js';

export const ALERT_DATA_STALE = 'DATA_STALE';
export const ALERT_ACK_TIMEOUT = 'ACK_TIMEOUT';
export const ALERT_ACCOUNT_NOT_TRADEABLE = 'ACCOUNT_NOT_TRADEABLE';
export const ALERT_VALIDATION_FAILURE = 'VALIDATION_FAILURE';

export type AlertLevel = 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';

export type CycleAlert = {
  level: AlertLevel;
  code: string;
  message: string;
  ts: string;
};

/** Recent ACK_TIMEOUT errors keep entries blocked this long. */
export const ACK_TIMEOUT_ENTRY_BLOCK_MS = 60_000;

export function dispatchCycleAlerts(input: {
  data_stale: boolean;
  freshness_ms: number | null;
  stale_threshold_ms: number;
  account_not_tradeable: boolean;
  validation_failed?: boolean;
  validation_message?: string | null;
  now_ms?: number;
  /** Lookback for ACK_TIMEOUT in error journal */
  ack_timeout_lookback_ms?: number;
}): CycleAlert[] {
  const now = input.now_ms ?? Date.now();
  const out: CycleAlert[] = [];
  const ts = new Date(now).toISOString();

  if (input.data_stale && input.freshness_ms != null) {
    out.push({
      level: 'WARNING',
      code: ALERT_DATA_STALE,
      message: `market data stale freshness_ms=${Math.round(input.freshness_ms)} threshold_ms=${input.stale_threshold_ms}`,
      ts,
    });
  }
  if (input.account_not_tradeable) {
    out.push({
      level: 'CRITICAL',
      code: ALERT_ACCOUNT_NOT_TRADEABLE,
      message: 'account_not_tradeable',
      ts,
    });
  }
  if (input.validation_failed) {
    out.push({
      level: 'ERROR',
      code: ALERT_VALIDATION_FAILURE,
      message: input.validation_message || 'validation failure',
      ts,
    });
  }

  const lookback = input.ack_timeout_lookback_ms ?? ACK_TIMEOUT_ENTRY_BLOCK_MS;
  const recentAck = loadMasterErrors(40).find((e) => {
    if (e.error_type !== 'ACK_TIMEOUT') return false;
    const t = Date.parse(e.ts);
    return Number.isFinite(t) && now - t <= lookback;
  });
  if (recentAck) {
    out.push({
      level: 'ERROR',
      code: ALERT_ACK_TIMEOUT,
      message: recentAck.message || 'ACK_TIMEOUT',
      ts: recentAck.ts,
    });
  }

  return out;
}

/**
 * Entry block reason from active alerts — null when clear.
 * DATA_STALE / ACCOUNT_NOT_TRADEABLE / ACK_TIMEOUT / VALIDATION_FAILURE block.
 */
export function alertsBlockEntries(alerts: CycleAlert[]): string | null {
  for (const a of alerts) {
    if (a.code === ALERT_ACCOUNT_NOT_TRADEABLE) {
      return `alert:${ALERT_ACCOUNT_NOT_TRADEABLE}`;
    }
    if (a.code === ALERT_ACK_TIMEOUT) {
      return `alert:${ALERT_ACK_TIMEOUT}`;
    }
    if (a.code === ALERT_DATA_STALE) {
      return `alert:${ALERT_DATA_STALE}`;
    }
    if (a.code === ALERT_VALIDATION_FAILURE) {
      return `alert:${ALERT_VALIDATION_FAILURE}`;
    }
  }
  return null;
}

/** Instance health from alert severity (Reader monitoring_store pattern). */
export function healthFromAlerts(alerts: CycleAlert[]): 'OK' | 'DEGRADED' | 'CRITICAL' {
  if (alerts.some((a) => a.level === 'CRITICAL')) return 'CRITICAL';
  if (alerts.some((a) => a.level === 'ERROR' || a.level === 'WARNING')) {
    return 'DEGRADED';
  }
  return 'OK';
}
