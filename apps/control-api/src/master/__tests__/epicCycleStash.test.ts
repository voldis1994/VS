import { describe, expect, it } from 'vitest';
import { mkdtempSync, unlinkSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadEpicCycleStash,
  saveEpicCycleStash,
} from '../epicCycleStash.js';
import { emptySetup } from '../../services/marketSetup.js';
import { ensureOperatorMetaFromStateDir } from '../filePersist.js';

describe('epicCycleStash persist/hydrate', () => {
  it('round-trips GOLD+SILVER setups and cycles', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vs-epic-stash-'));
    const ok = saveEpicCycleStash(
      {
        setups_by_epic: {
          GOLD: {
            setup: {
              ...emptySetup('gold_armed'),
              kind: 'CONTINUATION',
              side: 'BUY',
              status: 'ARMED',
              reason: 'gold_armed',
              confirm: 2,
            },
            structure: null,
          },
          SILVER: {
            setup: {
              ...emptySetup('silver_watch'),
              kind: 'CONTINUATION',
              side: 'SELL',
              status: 'FORMING',
              reason: 'silver_watch',
              confirm: 0,
            },
            structure: null,
          },
        },
        cycles_by_epic: {
          GOLD: {
            at: new Date().toISOString(),
            market_setup: {
              kind: 'CONTINUATION',
              side: 'BUY',
              status: 'ARMED',
              reason: 'gold_armed',
              confirm: 2,
            },
            last_market: {
              ok: true,
              quality: 0.9,
              reasons: [],
              bars_in: 40,
              bars_out: 40,
            },
            decision_kind: 'WAIT',
            buy_score: 0.7,
            sell_score: 0.3,
          },
          SILVER: {
            at: new Date().toISOString(),
            market_setup: {
              kind: 'CONTINUATION',
              side: 'SELL',
              status: 'FORMING',
              reason: 'silver_watch',
              confirm: 0,
            },
            last_market: {
              ok: true,
              quality: 0.8,
              reasons: [],
              bars_in: 40,
              bars_out: 40,
            },
            decision_kind: 'BLOCK',
            buy_score: 0.2,
            sell_score: 0.6,
          },
        },
      },
      dir
    );
    expect(ok).toBe(true);
    const loaded = loadEpicCycleStash(dir);
    expect(loaded).toBeTruthy();
    expect(loaded!.setups_by_epic.GOLD?.setup?.reason).toBe('gold_armed');
    expect(loaded!.setups_by_epic.SILVER?.setup?.reason).toBe('silver_watch');
    expect(loaded!.cycles_by_epic.GOLD?.decision_kind).toBe('WAIT');
    expect(loaded!.cycles_by_epic.SILVER?.decision_kind).toBe('BLOCK');
  });

  it('heals wiped sidecar from master_state operator_meta', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vs-epic-stash-heal-'));
    const stash = {
      at: new Date().toISOString(),
      setups_by_epic: {
        GOLD: {
          setup: { ...emptySetup('heal'), status: 'ARMED', side: 'BUY', kind: 'CONTINUATION', reason: 'heal', confirm: 1 },
          structure: null,
        },
      },
      cycles_by_epic: {
        GOLD: {
          at: new Date().toISOString(),
          market_setup: {
            kind: 'CONTINUATION',
            side: 'BUY' as const,
            status: 'ARMED',
            reason: 'heal',
            confirm: 1,
          },
          last_market: null,
          decision_kind: 'WAIT',
          buy_score: 0.5,
          sell_score: 0.4,
        },
      },
      saved_at_ms: Date.now(),
    };
    writeFileSync(
      join(dir, 'master_state.json'),
      JSON.stringify({
        opportunities: [],
        outcomes: [],
        positions: [],
        intents: [],
        operator_meta: { epic_cycle_stash: stash },
      }),
      'utf8'
    );
    const sidecar = join(dir, 'epic_cycle_stash.json');
    expect(existsSync(sidecar)).toBe(false);
    expect(ensureOperatorMetaFromStateDir(dir)).toBe(true);
    expect(existsSync(sidecar)).toBe(true);
    const raw = JSON.parse(readFileSync(sidecar, 'utf8'));
    expect(raw.setups_by_epic.GOLD.setup.reason).toBe('heal');
  });
});
