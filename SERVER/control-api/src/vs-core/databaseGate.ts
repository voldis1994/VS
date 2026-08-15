/**
 * Database failure / authoritative-state gate — trading blocked when DB cannot persist.
 */

export type DbHealth = {
  available: boolean;
  writable: boolean;
  schema_ok: boolean;
  detail: string;
};

export type DbGateResult = {
  trading_allowed: boolean;
  reason_code: string | null;
  health: DbHealth;
};

/** Pure policy: if DB unavailable/unwritable/schema mismatch → block new entries. */
export function evaluateDatabaseGate(health: DbHealth): DbGateResult {
  if (!health.available) {
    return {
      trading_allowed: false,
      reason_code: 'DATABASE_UNAVAILABLE',
      health,
    };
  }
  if (!health.writable) {
    return {
      trading_allowed: false,
      reason_code: 'DATABASE_WRITE_FAILURE',
      health,
    };
  }
  if (!health.schema_ok) {
    return {
      trading_allowed: false,
      reason_code: 'DATABASE_SCHEMA_MISMATCH',
      health,
    };
  }
  return { trading_allowed: true, reason_code: null, health };
}

export function simulateDbFixture(
  mode: 'ok' | 'down' | 'readonly' | 'schema_mismatch' | 'corrupt_record'
): DbHealth {
  switch (mode) {
    case 'ok':
      return { available: true, writable: true, schema_ok: true, detail: 'ok' };
    case 'down':
      return { available: false, writable: false, schema_ok: false, detail: 'connection refused' };
    case 'readonly':
      return { available: true, writable: false, schema_ok: true, detail: 'read-only transaction' };
    case 'schema_mismatch':
      return { available: true, writable: true, schema_ok: false, detail: 'expected migration 010' };
    case 'corrupt_record':
      return {
        available: true,
        writable: true,
        schema_ok: true,
        detail: 'corrupt fixture detected — treat as write failure for safety',
      };
    default:
      return { available: false, writable: false, schema_ok: false, detail: 'unknown' };
  }
}

/** Corrupt record → force not writable for trading safety. */
export function evaluateDatabaseGateSafe(health: DbHealth): DbGateResult {
  if (health.detail.includes('corrupt')) {
    return evaluateDatabaseGate({ ...health, writable: false });
  }
  return evaluateDatabaseGate(health);
}
