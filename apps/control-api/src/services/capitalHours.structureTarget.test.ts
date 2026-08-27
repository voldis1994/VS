/**
 * Regression: Capital openingHours gap classification + BO structure_target persist.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseCapitalOpeningHours,
  classifyBarGapWithOpeningHours,
  isCapitalMarketOpenAt,
  parseHmToMinutes,
} from './tradingSessions.js';
import { classifyBarGap, TF_MS, evaluateTfBook, type TfBar } from './timeframeBooks.js';
import {
  buildBoStateFromOpen,
  adoptBrokerOpenForBo,
  saveBoState,
  loadBoState,
  resetTradeRecoveryStore,
} from './tradeRecovery.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Mon–Fri 07:00–21:00 UTC — Capital per-day map shape */
function weekdayHoursRaw() {
  const slot = [{ openTime: '07:00', closeTime: '21:00' }];
  return {
    monday: slot,
    tuesday: slot,
    wednesday: slot,
    thursday: slot,
    friday: slot,
  };
}

/** 24/7 Capital hours — every day 00:00–23:59:59 */
function cryptoHoursRaw() {
  const slot = [{ openTime: '00:00', closeTime: '23:59:59' }];
  return {
    sunday: slot,
    monday: slot,
    tuesday: slot,
    wednesday: slot,
    thursday: slot,
    friday: slot,
    saturday: slot,
  };
}

describe('Capital openingHours — never guess from epic/gap length', () => {
  it('parseHmToMinutes accepts HH:mm and HH:mm:ss', () => {
    expect(parseHmToMinutes('07:00')).toBe(7 * 60);
    expect(parseHmToMinutes('23:59:59')).toBe(23 * 60 + 59);
    expect(parseHmToMinutes('bad')).toBeNull();
  });

  it('parseCapitalOpeningHours requires Capital day map — empty/null → null', () => {
    expect(parseCapitalOpeningHours(null)).toBeNull();
    expect(parseCapitalOpeningHours({})).toBeNull();
    expect(parseCapitalOpeningHours({ marketTimes: [{ openTime: '07:00', closeTime: '21:00' }] })).toBeNull();
  });

  it('parses Capital per-day openingHours', () => {
    const hours = parseCapitalOpeningHours(weekdayHoursRaw(), { timezone: 'UTC' });
    expect(hours).not.toBeNull();
    expect(hours!.windows.length).toBe(5);
    expect(hours!.continuously_open).toBe(false);
    expect(hours!.timezone_from_capital).toBe(true);
  });

  it('crypto 24/7 Capital hours → continuously_open', () => {
    const hours = parseCapitalOpeningHours(cryptoHoursRaw(), { timezone: 'UTC' });
    expect(hours!.continuously_open).toBe(true);
  });

  it('without Capital hours: excess gap is UNKNOWN (not weekend heuristic)', () => {
    const step = TF_MS['1H'];
    expect(classifyBarGap(0, 60 * 3_600_000, step)).toBe('unknown');
    expect(classifyBarGap(0, 12 * 3_600_000, step)).toBe('unknown');
    expect(classifyBarGapWithOpeningHours(0, 60 * 3_600_000, step, null)).toBe('unknown');
  });

  it('Capital weekday hours: weekend gap = session; mid-week hole while open = missing', () => {
    const hours = parseCapitalOpeningHours(weekdayHoursRaw(), { timezone: 'UTC' })!;
    const step = TF_MS['1H'];
    // Friday 20:00 UTC → Monday 07:00 UTC (first open hour after weekend)
    const fri20 = Date.UTC(2024, 0, 5, 20, 0, 0); // Jan 5 2024 = Friday
    const mon07 = Date.UTC(2024, 0, 8, 7, 0, 0); // Monday open
    expect(classifyBarGapWithOpeningHours(fri20, mon07, step, hours)).toBe('session');

    // Tuesday 10:00 → Tuesday 16:00 (market should be open) → missing
    const tue10 = Date.UTC(2024, 0, 2, 10, 0, 0);
    const tue16 = Date.UTC(2024, 0, 2, 16, 0, 0);
    expect(isCapitalMarketOpenAt(tue10 + step, hours)).toBe(true);
    expect(classifyBarGapWithOpeningHours(tue10, tue16, step, hours)).toBe('missing');
  });

  it('Capital 24/7 hours: any excess gap = missing (never session from length)', () => {
    const hours = parseCapitalOpeningHours(cryptoHoursRaw(), { timezone: 'UTC' })!;
    expect(
      classifyBarGapWithOpeningHours(0, 60 * 3_600_000, TF_MS['1H'], hours)
    ).toBe('missing');
    expect(
      classifyBarGapWithOpeningHours(0, 8 * 3_600_000, TF_MS['1H'], hours)
    ).toBe('missing');
  });

  it('source never guesses session from epic name / category', () => {
    const sess = readFileSync(join(here, 'tradingSessions.ts'), 'utf8');
    expect(sess).not.toMatch(/sessionMetaForEpic/);
    expect(sess).not.toMatch(/sessionMetaForCategory/);
    expect(sess).not.toMatch(/BTC\|ETH/);
    expect(sess).toMatch(/parseCapitalOpeningHours/);
    const seed = readFileSync(join(here, 'seedMultiTf.ts'), 'utf8');
    expect(seed).toMatch(/fetchCapitalOpeningHours/);
    expect(seed).not.toMatch(/sessionMetaForEpic/);
  });

  it('evaluateTfBook: unknown gaps without Capital hours → NOT_READY', () => {
    const step = TF_MS['1H'];
    const t0 = Date.UTC(2024, 0, 2, 8, 0, 0);
    const bars: TfBar[] = [];
    for (let i = 0; i < 30; i++) {
      bars.push({
        open_time_ms: t0 + i * step,
        open: 100 + i * 0.01,
        high: 101 + i * 0.01,
        low: 99 + i * 0.01,
        close: 100.5 + i * 0.01,
        ticks: 5,
        provenance: 'REAL',
        source_tf: '1H',
      });
    }
    bars[10]!.open_time_ms = bars[9]!.open_time_ms + 60 * 3_600_000;
    for (let i = 11; i < bars.length; i++) {
      bars[i]!.open_time_ms = bars[i - 1]!.open_time_ms + step;
    }
    const now = bars[bars.length - 1]!.open_time_ms + step * 2;
    const book = evaluateTfBook('1H', bars, 'CAPITAL_NATIVE', now, null);
    expect(book.ready).toBe(false);
    expect(book.detail).toMatch(/unknown gaps|Capital openingHours/i);
  });
});

describe('BO structure_target persist / restart restore', () => {
  beforeEach(() => resetTradeRecoveryStore());

  it('buildBoStateFromOpen persists structure_target', () => {
    const bo = buildBoStateFromOpen({
      deal_id: 'D1',
      side: 'BUY',
      entry_price: 4640,
      epic: 'GOLD',
      account_id: 1,
      robot_id: '1:GOLD',
      structure_target: 12.5,
    });
    expect(bo.structure_target).toBe(12.5);
    saveBoState(bo);
    expect(loadBoState('1:GOLD')?.structure_target).toBe(12.5);
  });

  it('adoptBrokerOpenForBo restores prior structure_target after restart', () => {
    const prior = buildBoStateFromOpen({
      deal_id: 'D1',
      side: 'BUY',
      entry_price: 4640,
      epic: 'GOLD',
      account_id: 1,
      robot_id: '1:GOLD',
      structure_target: 18.25,
      mfe: 4,
    });
    saveBoState(prior);
    const adopted = adoptBrokerOpenForBo({
      prior: loadBoState('1:GOLD'),
      deal_id: 'D1',
      side: 'BUY',
      open_level: 4640.5,
      epic: 'GOLD',
      account_id: 1,
      robot_id: '1:GOLD',
    });
    expect(adopted.structure_target).toBe(18.25);
    expect(adopted.mfe).toBe(4);
  });

  it('robotDesk wires structure_target into persist + restart recover (source)', () => {
    const src = readFileSync(join(here, 'robotDesk.ts'), 'utf8');
    expect(src).toMatch(/structure_target:\s*s\.structure_target/);
    expect(src).toMatch(/session\.structure_target\s*=\s*priorBo\.structure_target/);
    expect(src).toMatch(/prior\.structure_target/);
    const recovery = readFileSync(join(here, 'tradeRecovery.ts'), 'utf8');
    expect(recovery).toMatch(/structure_target/);
  });
});
