/**
 * Live wiring audit — locks what we claim about ENTRY trigger + BO + HTF bias.
 * Fails if code drifts from the contracts the desk depends on.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EPIC_PAUSE_MS, allowEpicReentry, noteEpicTradeClose, resetEpicTradeCooldowns } from './tradeCooldown.js';
import { holdTriggeredForDecidePath, formatArmedTriggerDiag } from './entryPlan.js';
import { idleArmedState } from './earlyEntryArmed.js';
import { decideBestOutcomeExit } from './exitManage.js';
import { buildHtfContextFromBooks, emptyMultiTfState } from './timeframeBooks.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('live wiring audit', () => {
  it('EARLY path has no impulse/late-chase after signal (source)', () => {
    const src = readFileSync(join(here, 'entryFromRegime.ts'), 'utf8');
    const earlyIdx = src.indexOf('Early path: SETUP');
    expect(earlyIdx).toBeGreaterThan(0);
    const earlyBlock = src.slice(earlyIdx, earlyIdx + 1200);
    expect(earlyBlock).toMatch(/TRIGGERED → fill|No post-trigger impulse/);
    expect(earlyBlock).not.toMatch(/allowEntryAgainstImpulse\(early\.signal/);
    expect(earlyBlock).not.toMatch(/blockLateTrendChase\(early\.signal/);
  });

  it('Strong/late path also has no post-decision impulse/chase (source)', () => {
    const src = readFileSync(join(here, 'entryFromRegime.ts'), 'utf8');
    const strongIdx = src.indexOf('Strong/late path');
    expect(strongIdx).toBeGreaterThan(0);
    const strongBlock = src.slice(strongIdx, strongIdx + 500);
    expect(strongBlock).toMatch(/No post-decision impulse/);
    expect(strongBlock).not.toMatch(/allowEntryAgainstImpulse\(decision/);
    expect(strongBlock).not.toMatch(/blockLateTrendChase\(decision/);
  });

  it('structure_target manage seed never falls back to zone edge (source)', () => {
    const src = readFileSync(join(here, 'robotDesk.ts'), 'utf8');
    expect(src).not.toMatch(/ms\.last_swing_high\?\.price\s*\?\?\s*zone\?\.high/);
    expect(src).not.toMatch(/ms\.last_swing_low\?\.price\s*\?\?\s*zone\?\.low/);
  });

  it('explainNoEntry passes multiTfReady so diagnostics match decide (source)', () => {
    const src = readFileSync(join(here, 'entryFromRegime.ts'), 'utf8');
    const idx = src.indexOf('export function explainNoEntry');
    expect(idx).toBeGreaterThan(0);
    const block = src.slice(idx, idx + 900);
    expect(block).toMatch(/multiTfReady:\s*opts\?\.multiTfReady\s*\?\?\s*true/);
  });

  it('robotDesk skips stale+reentry for EARLY/TRIGGERED reason', () => {
    const src = readFileSync(join(here, 'robotDesk.ts'), 'utf8');
    expect(src).toMatch(/isEarlyTrigger\s*=\s*\/EARLY\|TRIGGERED/i);
    expect(src).toMatch(/if\s*\(\s*!isEarlyTrigger\s*\)/);
    expect(src).toMatch(/armed_trigger = idleArmedState\(\)/);
  });

  it('BO soft exits wait full 5 minutes; HardInv still immediate', () => {
    const src = readFileSync(join(here, 'exitManage.ts'), 'utf8');
    expect(src).toMatch(/YOUNG_MS\s*=\s*5\s*\*\s*60_000/);

    const young = {
      open_side: 'BUY' as const,
      entry_price: 100,
      entry_at: new Date().toISOString(),
      mfe: 0.5,
      mae: 0,
      peak_retention: null,
      atr: 1,
      tick_size: 0.01,
      regime: 'TREND_DOWN',
    };
    expect(decideBestOutcomeExit(young, 100.1).exit).toBe(false);

    const aged = {
      ...young,
      entry_at: new Date(Date.now() - 6 * 60_000).toISOString(),
    };
    expect(decideBestOutcomeExit(aged, 100.1).exit).toBe(true);
  });

  it('HTF bias weights 4H×3 > 1H×2 > 15m×1 (source)', () => {
    const src = readFileSync(join(here, 'timeframeBooks.ts'), 'utf8');
    expect(src).toMatch(/biasOf\(ms4\.trend\)\s*\*\s*3/);
    expect(src).toMatch(/biasOf\(ms1\.trend\)\s*\*\s*2/);
    expect(src).toMatch(/biasOf\(ms15\.trend\)\s*\*\s*1/);
  });

  it('HTF NOT READY when any of 4H/1H/15m missing', () => {
    const htf = buildHtfContextFromBooks(emptyMultiTfState(), 100);
    expect(htf.trend).toBeNull();
    expect(htf.detail).toMatch(/NOT READY|4H\+1H\+15m/i);
  });

  it('UI refresh must not leave TRIGGERED (consume-fire bug)', () => {
    const held = holdTriggeredForDecidePath(
      {
        ...idleArmedState(),
        phase: 'TRIGGERED',
        direction: 'BUY',
        micro_score: 2,
        confirms: ['rejection'],
      },
      { direction: 'BUY' }
    );
    expect(held.phase).toBe('ARMED');
    expect(held.micro_score).toBe(2);
  });

  it('reentry pause 90s exists but EARLY path bypasses it in robotDesk', () => {
    resetEpicTradeCooldowns();
    expect(EPIC_PAUSE_MS).toBe(90_000);
    noteEpicTradeClose('GOLD', 'BUY', true);
    expect(allowEpicReentry('GOLD', 'BUY').ok).toBe(false);
    const src = readFileSync(join(here, 'robotDesk.ts'), 'utf8');
    expect(src).toMatch(/if\s*\(\s*!isEarlyTrigger\s*\)[\s\S]*allowEpicReentry/);
  });

  it('ARMED_DIAG exposes micro score for blocked ticks', () => {
    const line = formatArmedTriggerDiag(
      {
        ...idleArmedState(),
        phase: 'ARMED',
        direction: 'BUY',
        zone_low: 100,
        zone_high: 101,
        micro_score: 0,
        detail: 'ARMED',
      },
      101.5
    );
    expect(line).toMatch(/NEED_MICRO 0\/2/);
  });
});
