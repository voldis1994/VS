/**
 * LIVE entry must NOT depend on Capital balance/equity.
 * Manual lot_size is authoritative; riskWindow is monitor-only.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  allowRiskEntry,
  evaluateRiskWindow,
  resetRiskWindows,
  setRiskEquity,
  noteRiskTradeOpen,
} from './riskWindow.js';

const here = dirname(fileURLToPath(import.meta.url));
const deskSrc = readFileSync(join(here, 'robotDesk.ts'), 'utf8');
const fanSrc = readFileSync(join(here, 'intentFanout.ts'), 'utf8');

describe('LIVE entry — no account-equity gate', () => {
  beforeEach(() => resetRiskWindows());

  it('UNKNOWN equity + manual lot_size → allowRiskEntry continues (ok)', () => {
    const r = allowRiskEntry(501, 0, 2_000_000);
    expect(r.ok).toBe(true);
    expect(r.snapshot.equity_start).toBeNull();
    expect(r.snapshot.status).toBe('SEEDING');
    expect(r.reason).not.toMatch(/no entry until Capital balance/i);
    expect(r.reason).not.toMatch(/RISK wait equity/i);
  });

  it('UNKNOWN equity with open UPL still allows entry (informational SEEDING)', () => {
    const { allowEntry, snapshot } = evaluateRiskWindow(502, -12.5, 2_100_000);
    expect(allowEntry).toBe(true);
    expect(snapshot.equity_start).toBeNull();
    expect(snapshot.pnl_pct).toBeNull();
  });

  it('LIVE desk does not early-return on riskWindow.ok (monitor only)', () => {
    expect(deskSrc).toMatch(/persistRiskSnapshotJson/);
    expect(deskSrc).toMatch(/allowRiskEntry/);
    expect(deskSrc).not.toMatch(/RISK gate\s*·/);
    expect(deskSrc).not.toMatch(/if\s*\(\s*!risk\.ok\s*\)/);
    expect(deskSrc).not.toMatch(/no entry until Capital balance known/);
  });

  it('LIVE order size is manual lot_size only (no equity sizing)', () => {
    expect(deskSrc).toMatch(/size:\s*s\.lot_size/);
    expect(fanSrc).toMatch(/size:\s*sub\.lot_size/);
    expect(deskSrc).not.toMatch(/computeRiskPositionSize/);
    expect(deskSrc).not.toMatch(/fetchCapitalAccountEquity/);
    expect(fanSrc).not.toMatch(/computeRiskPositionSize/);
  });

  it('seeded equity still allows IDLE entry; % monitor remains available', () => {
    const t0 = 3_000_000;
    setRiskEquity(503, 10_000, t0);
    expect(allowRiskEntry(503, 0, t0).ok).toBe(true);
    noteRiskTradeOpen(503, t0);
    const active = allowRiskEntry(503, 50, t0 + 5_000);
    expect(active.snapshot.status).toBe('ACTIVE');
    expect(active.snapshot.equity_start).toBe(10_000);
  });
});
