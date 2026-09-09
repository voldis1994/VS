import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { logDecisionEvent, loadDecisionEvents } from '../decisionJournal.js';

describe('decision journal desk_entry provenance', () => {
  let dir: string;
  let prevState: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vs-desk-entry-jnl-'));
    prevState = process.env.MASTER_STATE_DIR;
    process.env.MASTER_STATE_DIR = dir;
  });

  afterEach(() => {
    if (prevState == null) delete process.env.MASTER_STATE_DIR;
    else process.env.MASTER_STATE_DIR = prevState;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('persists desk_entry_source / hour_bias / closed_10s_present on DecisionEvent', () => {
    logDecisionEvent({
      kind: 'WAIT',
      epic: 'GOLD',
      mode: 'PAPER',
      opportunity_id: 'opp-desk-1',
      buy_score: 0.6,
      sell_score: 0.4,
      block_reason: 'setup_confirm_pending',
      desk_entry_source: 'move',
      desk_entry_side: 'SELL',
      hour_bias: 'UP',
      closed_10s_present: true,
    });
    const rows = loadDecisionEvents(5);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows.find((e) => e.opportunity_id === 'opp-desk-1');
    expect(row).toBeTruthy();
    expect(row!.desk_entry_source).toBe('move');
    expect(row!.desk_entry_side).toBe('SELL');
    expect(row!.hour_bias).toBe('UP');
    expect(row!.closed_10s_present).toBe(true);
  });

  it('nulls provenance when omitted (legacy rows stay readable)', () => {
    logDecisionEvent({
      kind: 'BUY',
      epic: 'GOLD',
      mode: 'PAPER',
      opportunity_id: 'opp-legacy-1',
      executed: true,
      execution_detail: 'paper_fill',
    });
    const row = loadDecisionEvents(5).find((e) => e.opportunity_id === 'opp-legacy-1');
    expect(row).toBeTruthy();
    expect(row!.desk_entry_source).toBeNull();
    expect(row!.desk_entry_side).toBeNull();
    expect(row!.hour_bias).toBeNull();
    expect(row!.closed_10s_present).toBeNull();
  });
});
