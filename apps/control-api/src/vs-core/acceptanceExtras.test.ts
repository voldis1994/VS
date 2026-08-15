import { describe, it, expect } from 'vitest';
import { CapitalSessionManager } from './capitalSessionManager.js';
import { FeedManager } from './feedManager.js';
import { runCrashRecovery } from './crashRecovery.js';
import { runStrategyRegression } from './strategyRegression.js';
import { runAcceptanceGates } from './acceptanceGate.js';
import { evaluateRisk } from './riskCore.js';

describe('CapitalSessionManager', () => {
  it('isolates clients and never exposes secrets in redact', async () => {
    const mgr = new CapitalSessionManager({
      login: async () => ({
        ok: true,
        status: 200,
        cst: 'SECRET_CST',
        security_token: 'SECRET_TOK',
        detail: 'ok',
      }),
      probe: async () => ({ ok: true, status: 200, detail: 'ok' }),
    });
    mgr.setCredentials(1, 10, 100, {
      api_key: 'key',
      identifier: 'a@b.c',
      password: 'pw',
      environment: 'demo',
    });
    const s = await mgr.connect(1, 10);
    expect(s.health).toBe('CONNECTED');
    expect(mgr.assertIsolation(1, 2)).toBe(false);
    const red = CapitalSessionManager.redact(s);
    expect(JSON.stringify(red)).not.toContain('SECRET_CST');
    expect(red.has_tokens).toBe(true);
  });

  it('handles 429 without claiming CONNECTED', async () => {
    const mgr = new CapitalSessionManager({
      login: async () => ({ ok: false, status: 429, detail: 'slow down' }),
      probe: async () => ({ ok: false, status: 429, detail: 'slow down' }),
    });
    mgr.setCredentials(1, 1, 1, {
      api_key: 'k',
      identifier: 'u',
      password: 'p',
      environment: 'demo',
    });
    const s = await mgr.connect(1, 1);
    expect(s.health).toBe('RATE_LIMITED');
    expect(mgr.isTradingAllowed(1, 1)).toBe(false);
  });
});

describe('FeedManager PRIMARY guard', () => {
  it('blocks execution when PRIMARY offline even if reference LIVE', () => {
    const fm = new FeedManager();
    fm.defineSource('capital', 'PRIMARY');
    fm.defineSource('yahoo', 'REFERENCE');
    fm.markOffline('capital', 'GOLD');
    fm.ingest({
      source: 'yahoo',
      epic: 'GOLD',
      bid: 100,
      ask: 100.1,
      source_timestamp: new Date().toISOString(),
    });
    const snap = fm.snapshot('GOLD');
    expect(snap.allows_execution).toBe(false);
    expect(snap.block_reason).toBe('PRIMARY_FEED_OFFLINE');
  });

  it('allows execution only when PRIMARY LIVE', () => {
    const fm = new FeedManager();
    fm.defineSource('capital', 'PRIMARY');
    fm.ingest({
      source: 'capital',
      epic: 'GOLD',
      bid: 100,
      ask: 100.1,
      source_timestamp: new Date().toISOString(),
    });
    expect(fm.snapshot('GOLD').allows_execution).toBe(true);
  });
});

describe('Crash recovery', () => {
  it('blocks entries until reconcile clean', async () => {
    const mgr = new CapitalSessionManager({
      login: async () => ({
        ok: true,
        status: 200,
        cst: 'c',
        security_token: 's',
        detail: 'ok',
      }),
      probe: async () => ({ ok: true, status: 200, detail: 'ok' }),
    });
    mgr.setCredentials(1, 1, 1, {
      api_key: 'k',
      identifier: 'u',
      password: 'p',
      environment: 'demo',
    });
    const dirty = await runCrashRecovery({
      networkOk: async () => true,
      sessionManager: mgr,
      client_id: 1,
      account_id: 1,
      loadLocalPositions: async () => [
        { account_id: 1, client_id: 1, epic: 'GOLD', direction: 'BUY', deal_id: 'X', size: 1 },
      ],
      loadBrokerPositions: async () => [],
      loadWorkingOrders: async () => ({ ok: true, count: 0, detail: 'n' }),
      loadRecentFills: async () => ({ ok: true, count: 0, detail: 'n' }),
      databaseOk: async () => true,
      restoreStrategy: async () => ({ ok: true, detail: 'ok' }),
    });
    expect(dirty.entries_allowed).toBe(false);
    expect(dirty.reason_code).toBe('POSITION_STATE_MISMATCH');
  });
});

describe('Strategy regression baseline', () => {
  it('matches locked fingerprint codes (no silent behavior change)', () => {
    const r = runStrategyRegression();
    if (r.behavior_change) {
      // Print diffs for operators
      const bad = r.cases.filter((c) => !c.ok);
      throw new Error(
        `STRATEGY BEHAVIOR CHANGE:\n` +
          bad.map((b) => `${b.id}: expected ${b.expected_code}/${b.expected_direction} got ${b.actual_code}/${b.actual_direction}`).join('\n')
      );
    }
    expect(r.failed).toBe(0);
    expect(r.passed).toBeGreaterThan(0);
  });
});

describe('Acceptance gate', () => {
  it('reports software-complete with EXTERNAL_BLOCKER for DEMO (no FAIL)', async () => {
    const report = await runAcceptanceGates();
    expect(report.summary.fail).toBe(0);
    expect(report.previous_master_task_complete).toBe(true);
    expect(report.live_readiness).toBe('NOT READY');
    const demo = report.gates.find((g) => g.name === 'CAPITAL_DEMO_E2E');
    expect(demo?.status).toBe('EXTERNAL_BLOCKER');
  });
});

describe('Risk + PRIMARY offline mapping', () => {
  it('feed_offline rejects', () => {
    const r = evaluateRisk({
      client_id: 1,
      account_id: 1,
      epic: 'GOLD',
      direction: 'BUY',
      size: 0.1,
      client_trading_enabled: true,
      market_open: true,
      feed_fresh: false,
      feed_offline: true,
      spread: 0.1,
      max_spread: null,
      has_open_position: false,
      has_duplicate_intent: false,
      in_cooldown: false,
      session_healthy: true,
      time_sync_ok: true,
      reconcile_clean: true,
      stop_attached: true,
      operating_mode: 'DEMO',
      live_trading_enabled: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('RISK_REJECTED_FEED_OFFLINE');
  });
});
