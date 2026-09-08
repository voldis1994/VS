import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mt4NumOrNull } from '../broker.js';
import { MasterJournal, mergeOutcomeSlices } from '../journal.js';
import { fromOutcomes } from '../performance.js';
import type { TradeOutcome } from '../types.js';

describe('MT4 numOrNull honesty (Capital null-profit parity)', () => {
  it('rejects null/empty so missing UPL/profit is not invented as 0', () => {
    expect(mt4NumOrNull(null)).toBeNull();
    expect(mt4NumOrNull(undefined)).toBeNull();
    expect(mt4NumOrNull('')).toBeNull();
    expect(mt4NumOrNull('abc')).toBeNull();
    expect(mt4NumOrNull(0)).toBe(0);
    expect(mt4NumOrNull('12.5')).toBe(12.5);
    expect(mt4NumOrNull(-1.2)).toBe(-1.2);
  });
});

describe('multi-slice journal recover → Fees KPI', () => {
  it('hydrate with all outcome slices keeps total_fees sum', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vs-multi-kpi-'));
    process.env.MASTER_STATE_DIR = dir;
    const { installFilePersist } = await import('../filePersist.js');
    const { persistOutcome, loadJournalHistory, persistOpportunity } = await import(
      '../persist.js'
    );
    installFilePersist(dir);

    const slice = (pnl: number, fees: number, reason: string): TradeOutcome => ({
      position_id: 'p-multi',
      side: 'BUY',
      entry: 4400,
      exit: 4410,
      volume: 0.5,
      pnl,
      fees,
      slippage: 0,
      mae: 0,
      mfe: 1,
      r_multiple: 1,
      hold_ms: 1000,
      exit_reason: reason,
    });

    const j = new MasterJournal();
    const rec = j.recordOpportunity({
      mode: 'PAPER',
      epic: 'GOLD',
      decision: {
        decision_id: 'd',
        kind: 'BUY',
        side: 'BUY',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: {
          regime: 'TREND',
          market_state: 'UP',
          session: 'LONDON',
        } as never,
        expectancy: null,
      },
      risk: { allowed: true, volume: 1, risk_amount: 1, reasons: [] },
      executed: true,
      id: 'opp-multi-kpi',
    });
    expect(await persistOpportunity(rec)).toBe(true);

    const a = slice(1, 0.05, 'PARTIAL_1');
    const b = slice(2, 0.05, 'TP_FINAL');
    j.attachOutcome(rec.id, a);
    j.attachOutcome(rec.id, b);
    expect(await persistOutcome(rec.id, a, 'BUY|TREND|UP|LONDON')).toBe(true);
    expect(await persistOutcome(rec.id, b, 'BUY|TREND|UP|LONDON')).toBe(true);

    const hist = await loadJournalHistory();
    const j2 = new MasterJournal();
    j2.hydrate(
      hist.opportunities,
      hist.outcomes.map((o) => o.outcome)
    );
    expect(j2.allCloseOutcomes().length).toBeGreaterThanOrEqual(2);
    const perf = fromOutcomes(j2.allCloseOutcomes());
    expect(perf.total_fees).toBeGreaterThanOrEqual(0.1 - 1e-9);
    expect(perf.total_pnl).toBeGreaterThanOrEqual(3 - 1e-9);

    const merged = hist.opportunities.find((o) => o.id === 'opp-multi-kpi')?.outcome;
    expect(merged).toBeTruthy();
    // display outcome should sum when multiple DB slices joined
    if (merged && hist.outcomes.filter((o) => o.opportunity_id === 'opp-multi-kpi').length > 1) {
      expect(merged.fees).toBeCloseTo(0.1, 8);
      expect(merged.pnl).toBeCloseTo(3, 8);
    }
    // merge helper sanity
    expect(mergeOutcomeSlices(a, b).pnl).toBeCloseTo(3, 8);
  });

  it('mergeOutcomeSlices fails-closed when any slice is unproven', () => {
    const proven: TradeOutcome = {
      position_id: 'p',
      side: 'BUY',
      entry: 100,
      exit: 101,
      volume: 1,
      pnl: -5,
      fees: 0.1,
      slippage: 0,
      mae: 1,
      mfe: 0,
      r_multiple: -1,
      hold_ms: 1000,
      exit_reason: 'PARTIAL',
      pnl_proven: true,
    };
    const unproven: TradeOutcome = {
      ...proven,
      pnl: 0,
      fees: 0,
      exit_reason: 'capital_close_pnl_unproven',
      pnl_proven: false,
    };
    expect(mergeOutcomeSlices(proven, unproven).pnl_proven).toBe(false);
    expect(mergeOutcomeSlices(unproven, proven).pnl_proven).toBe(false);
  });
});
