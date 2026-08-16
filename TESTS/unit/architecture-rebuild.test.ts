import { describe, it, expect } from 'vitest';
import { computeSupervisor } from '../../SERVER/core/supervisor/src/readiness.ts';
import { compareSets } from '../../SERVER/core/reconciliation/src/index.ts';
import { buildAuditEvent } from '../../SERVER/core/audit/src/index.ts';
import { parseCapitalEnv } from '../../SHARED/contracts/index.ts';

describe('supervisor readiness separation', () => {
  it('system can be ready while trading is not', () => {
    const snap = computeSupervisor([
      { name: 'PROCESS_READY', ok: true, detail: 'up' },
      { name: 'CONTROL_API_READY', ok: true, detail: 'up' },
      { name: 'DATABASE_READY', ok: true, detail: 'up' },
      { name: 'CLIENT_API_READY', ok: true, detail: 'up' },
      { name: 'BROKER_READY', ok: false, detail: 'CONFIG_REQUIRED', configRequired: true },
      { name: 'MARKET_DATA_READY', ok: false, detail: 'no feed' },
      { name: 'STRATEGY_READY', ok: true, detail: 'ok' },
      { name: 'RISK_READY', ok: true, detail: 'ok' },
      { name: 'EXECUTION_READY', ok: true, detail: 'ok' },
      { name: 'RECONCILIATION_READY', ok: false, detail: 'pending' },
    ]);
    expect(snap.process_ready).toBe(true);
    expect(snap.system_ready).toBe(true);
    expect(snap.trading_ready).toBe(false);
    expect(snap.trading_blockers.length).toBeGreaterThan(0);
  });
});

describe('reconciliation honesty', () => {
  it('blocks trading on mismatches', () => {
    const r = compareSets({ localOrderIds: ['a'], brokerOrderIds: ['b'] });
    expect(r.status).toBe('ISSUES');
    expect(r.tradingBlocked).toBe(true);
  });
});

describe('audit redaction + capital env', () => {
  it('redacts secrets', () => {
    const e = buildAuditEvent({
      actor: 'admin',
      action: 'test',
      detail: { token: 'secret', ok: true },
    });
    expect(e.detail.token).toBe('[REDACTED]');
    expect(e.detail.ok).toBe(true);
  });

  it('capital env explicit only', () => {
    expect(parseCapitalEnv('LIVE')).toBe('LIVE');
    expect(parseCapitalEnv('DEMO')).toBe('DEMO');
    expect(parseCapitalEnv('')).toBe('CONFIG_REQUIRED');
    expect(parseCapitalEnv('live-ish')).toBe('CONFIG_REQUIRED');
  });
});
