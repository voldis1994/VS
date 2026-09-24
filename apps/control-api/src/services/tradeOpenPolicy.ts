/**
 * Ultimate open start + auto-cal entry ladder.
 *
 * Level 0 — OPEN: soft entry filters off (boot / fresh session).
 * Level 1 — flip / same-dir lock
 * Level 2 — + structure / 1m bias / story knives
 * Level 3 — + same-dir next-move confirm + RANGE spike block
 *
 * Auto-cal raises/lowers this from closed-trade outcomes.
 * Still never: daily/% equity blocks, lot size changes.
 */
import { getDeskCalibration } from './deskCalibration.js';

export const TRADE_EVERYTHING_AT_START = true;
export const ENTRY_FILTER_LEVEL_MIN = 0;
export const ENTRY_FILTER_LEVEL_MAX = 3;

export type EntryFilterLevel = 0 | 1 | 2 | 3;

/** Test override — null = use desk calibration. */
let testLevelOverride: EntryFilterLevel | null = null;
/** Legacy bool override used by older tests. */
let testOpenOverride: boolean | null = null;

export function entryFilterLevel(): EntryFilterLevel {
  if (testLevelOverride != null) return testLevelOverride;
  if (testOpenOverride === true) return 0;
  if (testOpenOverride === false) return 3;
  const n = Number(getDeskCalibration().entry_filter_level);
  if (!Number.isFinite(n)) return 0;
  return Math.max(
    ENTRY_FILTER_LEVEL_MIN,
    Math.min(ENTRY_FILTER_LEVEL_MAX, Math.round(n))
  ) as EntryFilterLevel;
}

/** True only at level 0 — all soft entry filters bypassed. */
export function tradeOpenAtStart(): boolean {
  return entryFilterLevel() === 0;
}

export function entryFlipLockEnabled(): boolean {
  return entryFilterLevel() >= 1;
}

export function entryStructureEnabled(): boolean {
  return entryFilterLevel() >= 2;
}

export function entrySameDirConfirmEnabled(): boolean {
  return entryFilterLevel() >= 3;
}

export function entrySpikeBlockEnabled(): boolean {
  return entryFilterLevel() >= 3;
}

export function entryFilterLevelLabel(level = entryFilterLevel()): string {
  switch (level) {
    case 0:
      return 'OPEN (no soft filters)';
    case 1:
      return 'FLIP lock';
    case 2:
      return 'FLIP + structure';
    case 3:
      return 'STRICT (flip+structure+next-move)';
    default:
      return `L${level}`;
  }
}

/** Test-only — pass null to clear. */
export function _setTradeOpenAtStartForTests(value: boolean | null): void {
  testOpenOverride = value;
  if (value != null) testLevelOverride = null;
}

/** Test-only — pass null to clear. */
export function _setEntryFilterLevelForTests(value: EntryFilterLevel | null): void {
  testLevelOverride = value;
  if (value != null) testOpenOverride = null;
}
