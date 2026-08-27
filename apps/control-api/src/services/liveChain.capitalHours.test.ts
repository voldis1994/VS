/**
 * Real Capital `/markets/{epic}` openingHours (official Postman sample) + LIVE chain.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  parseCapitalOpeningHours,
  parseCapitalRangeString,
  classifyBarGapWithOpeningHours,
  isCapitalMarketOpenAt,
} from './tradingSessions.js';
import { classifyBarGap, TF_MS, evaluateTfBook, type TfBar } from './timeframeBooks.js';
import {
  buildBoStateFromOpen,
  saveBoState,
  loadBoState,
  resetTradeRecoveryStore,
  resolveEntryPrice,
  canClearPendingExecution,
  shouldRetryClose,
} from './tradeRecovery.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** Official Capital Postman SILVER-shaped openingHours */
const CAPITAL_SILVER_HOURS = {
  mon: ['00:00 - 22:00', '23:05 - 00:00'],
  tue: ['00:00 - 22:00', '23:05 - 00:00'],
  wed: ['00:00 - 22:00', '23:05 - 00:00'],
  thu: ['00:00 - 22:00', '23:05 - 00:00'],
  fri: ['00:00 - 22:00'],
  sat: [] as string[],
  sun: ['23:05 - 00:00'],
  zone: 'UTC',
};

describe('Capital real openingHours shape (Postman /markets/{epic})', () => {
  it('parses string ranges "HH:mm - HH:mm"', () => {
    expect(parseCapitalRangeString('00:00 - 22:00')).toEqual({
      open_min: 0,
      close_min: 22 * 60,
      overnight: false,
    });
    expect(parseCapitalRangeString('23:05 - 00:00')).toEqual({
      open_min: 23 * 60 + 5,
      close_min: 0,
      overnight: true,
    });
  });

  it('parses Capital SILVER hours with zone inside openingHours (no opts timezone)', () => {
    const hours = parseCapitalOpeningHours(CAPITAL_SILVER_HOURS);
    expect(hours).not.toBeNull();
    expect(hours!.timezone).toBe('UTC');
    expect(hours!.timezone_from_capital).toBe(true);
    expect(hours!.windows.length).toBeGreaterThan(5);
    expect(hours!.continuously_open).toBe(false);
    expect(hours!.detail).toMatch(/zone UTC/);
  });

  it('weekend gap Fri 22:00 → Sun 23:05 is session for SILVER hours', () => {
    const hours = parseCapitalOpeningHours(CAPITAL_SILVER_HOURS)!;
    const step = TF_MS['1H'];
    // Fri close at 22:00 — Fri 22:00 is closed; Sun opens 23:05
    const fri22 = Date.UTC(2024, 0, 5, 22, 0, 0);
    const sun2305 = Date.UTC(2024, 0, 7, 23, 5, 0);
    expect(isCapitalMarketOpenAt(fri22, hours)).toBe(false);
    expect(classifyBarGapWithOpeningHours(fri22, sun2305, step, hours)).toBe('session');
  });

  it('mid-session hole while Capital says open → missing', () => {
    const hours = parseCapitalOpeningHours(CAPITAL_SILVER_HOURS)!;
    const tue10 = Date.UTC(2024, 0, 2, 10, 0, 0);
    const tue16 = Date.UTC(2024, 0, 2, 16, 0, 0);
    expect(classifyBarGapWithOpeningHours(tue10, tue16, TF_MS['1H'], hours)).toBe('missing');
  });

  it('without zone → null (UNKNOWN)', () => {
    const { zone: _z, ...noZone } = CAPITAL_SILVER_HOURS;
    expect(parseCapitalOpeningHours(noZone)).toBeNull();
  });

  it('evaluateTfBook does not mark Capital-proven weekend gaps as unknown', () => {
    const hours = parseCapitalOpeningHours(CAPITAL_SILVER_HOURS)!;
    const step = TF_MS['1H'];
    const bars: TfBar[] = [];
    // Thu Jan 4 08:00 … Fri Jan 5 21:00 (last open hour Fri)
    let t = Date.UTC(2024, 0, 4, 8, 0, 0);
    const fri21 = Date.UTC(2024, 0, 5, 21, 0, 0);
    while (t <= fri21) {
      bars.push({
        open_time_ms: t,
        open: 24,
        high: 24.2,
        low: 23.9,
        close: 24.1,
        ticks: 5,
        provenance: 'REAL',
        source_tf: '1H',
      });
      t += step;
    }
    // Resume Sun 23:05 then through Mon
    let u = Date.UTC(2024, 0, 7, 23, 0, 0);
    const monEnd = Date.UTC(2024, 0, 8, 20, 0, 0);
    while (u <= monEnd) {
      bars.push({
        open_time_ms: u,
        open: 24,
        high: 24.2,
        low: 23.9,
        close: 24.1,
        ticks: 5,
        provenance: 'REAL',
        source_tf: '1H',
      });
      u += step;
    }
    const now = monEnd + step * 2;
    const book = evaluateTfBook('1H', bars, 'CAPITAL_NATIVE', now, hours);
    expect(book.detail).not.toMatch(/unknown gaps/i);
  });
});

describe('LIVE chain contracts after Capital hours fix', () => {
  beforeEach(() => resetTradeRecoveryStore());

  it('pending clear requires broker open_level — not confirm dealId alone (source)', () => {
    expect(canClearPendingExecution({ brokerOpen: false, fillLevel: 100 })).toBe(false);
    expect(canClearPendingExecution({ brokerOpen: true, fillLevel: 100 })).toBe(true);
    const src = readFileSync(join(here, 'robotDesk.ts'), 'utf8');
    expect(src).toMatch(/brokerOpen:\s*brokerLevel\s*!=\s*null/);
    expect(src).not.toMatch(/brokerOpen:\s*brokerLevel\s*!=\s*null\s*\|\|\s*Boolean\(s\.deal_id\)/);
  });

  it('close retry uses shouldRetryClose; reconcile notes Capital realized PnL (source)', () => {
    expect(shouldRetryClose('CLOSE_UNCERTAIN')).toBe(true);
    expect(shouldRetryClose('OPEN')).toBe(false);
    const src = readFileSync(join(here, 'robotDesk.ts'), 'utf8');
    expect(src).toMatch(/shouldRetryClose/);
    expect(src).toMatch(/CLOSE retry/);
    expect(src).toMatch(/tick_size:\s*quote\.point_size/);
    expect(src).toMatch(/seedMultiTfHistory\(opened\.session,\s*s\.epic/);
  });

  it('fanout fill uses resolveEntryPrice — not referencePrice invent (source)', () => {
    expect(resolveEntryPrice({ signal_mid: 1.1 })).toBeNull();
    const src = readFileSync(join(here, 'intentFanout.ts'), 'utf8');
    expect(src).toMatch(/resolveEntryPrice/);
    expect(src).toMatch(/FILL UNKNOWN/);
    expect(src).not.toMatch(/referencePrice != null && Number\.isFinite\(referencePrice\) \? Number\(referencePrice\) : mid/);
  });

  it('structure_target survives restart persist', () => {
    const bo = buildBoStateFromOpen({
      deal_id: 'D1',
      side: 'BUY',
      entry_price: 24.2,
      epic: 'SILVER',
      account_id: 1,
      robot_id: '1:SILVER',
      structure_target: 0.55,
    });
    saveBoState(bo);
    expect(loadBoState('1:SILVER')?.structure_target).toBe(0.55);
  });

  it('manual lot_size remains authoritative (source)', () => {
    const desk = readFileSync(join(here, 'robotDesk.ts'), 'utf8');
    const fan = readFileSync(join(here, 'intentFanout.ts'), 'utf8');
    expect(desk).toMatch(/size:\s*s\.lot_size/);
    expect(fan).toMatch(/size:\s*sub\.lot_size/);
    expect(desk).not.toMatch(/computeRiskPositionSize\(/);
  });
});
