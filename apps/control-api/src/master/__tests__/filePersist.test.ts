import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { installFilePersist } from '../filePersist.js';
import {
  loadOpenPositions,
  loadSeenIntents,
  saveOpenPositions,
  saveSeenIntents,
  setPersistClient,
} from '../persist.js';
import { PositionManager } from '../positionManager.js';
import { DEFAULT_MASTER_CONFIG, GOLD_SPEC, MasterPipeline } from '../pipeline.js';
import type { Bar, Quote } from '../types.js';

function barsTrendUp(n = 40): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const o = 4400 + i * 0.8;
    out.push({ open: o, high: o + 1.2, low: o - 0.1, close: o + 0.9, ts_ms: i * 60_000 });
  }
  return out;
}

function quoteFrom(bar: Bar): Quote {
  return {
    bid: bar.close - 0.2,
    ask: bar.close + 0.2,
    mid: bar.close,
    spread: 0.4,
    ts_ms: Date.now(),
  };
}

describe('VS MASTER file persist restart', () => {
  afterEach(() => setPersistClient(null));

  it('survives process-style restart via state file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vs-master-fp-'));
    installFilePersist(dir);

    const pipe = new MasterPipeline('PAPER');
    const bars = barsTrendUp();
    const cycle = pipe.runCycle({
      bars,
      quote: quoteFrom(bars.at(-1)!),
      account: {
        equity: 10_000,
        balance: 10_000,
        currency: 'GBP',
        open_positions: 0,
        daily_pnl: 0,
        peak_equity: 10_000,
        consecutive_losses: 0,
      },
      instrument: GOLD_SPEC,
      cfg: DEFAULT_MASTER_CONFIG,
    });

    const pm = new PositionManager();
    pm.register({
      position_id: 'file-pos-1',
      opportunity_id: cycle.opportunity.id,
      intent_id: 'file-intent-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry: 4410,
      decision: cycle.decision,
    });
    await saveOpenPositions(pm.list());
    await saveSeenIntents(['file-intent-1']);

    expect(existsSync(join(dir, 'master_state.json'))).toBe(true);
    const raw = JSON.parse(readFileSync(join(dir, 'master_state.json'), 'utf8'));
    expect(raw.positions.length).toBe(1);

    // Simulate restart — new FilePersist loads disk
    setPersistClient(null);
    installFilePersist(dir);
    const loaded = await loadOpenPositions();
    const intents = await loadSeenIntents();
    expect(loaded.length).toBe(1);
    expect(loaded[0]!.position_id).toBe('file-pos-1');
    expect(loaded[0]!.decision).toBeTruthy();
    expect(intents).toContain('file-intent-1');
  });
});
