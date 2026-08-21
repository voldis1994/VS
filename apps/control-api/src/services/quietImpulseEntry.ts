/**
 * Experimental (#137+): entry at the START of a move — quiet base → first impulse.
 * Classic pullback/confirm often buys the top after the move is done.
 *
 * Base (#136) path stays available via VS_ENTRY_MODE=classic.
 * #139: stricter quiet (fewer chop micro-impulses).
 */
import { bodyPct, isMoving10s, rangePct, type TenSecBar } from './tenSecondOhlc.js';
import type { RegimeEntry } from './entryFromRegime.js';

/** Tighter than #137 — chop 10s noise must not count as “quiet base”. */
const QUIET_BODY = 0.00009; // ~0.009%
const QUIET_RANGE = 0.00016;
const MIN_QUIET_BARS = 4;
const IMPULSE_BODY = 0.00026; // first real push (~1.2pt on Gold 4500)
/** If this single 10s body is already huge, move is likely underway — skip (late). */
const LATE_IMPULSE_BODY = 0.00080; // ~0.08% ≈ 3.6pt Gold — too much for "first tick"

function isQuietBar(bar: TenSecBar): boolean {
  return Math.abs(bodyPct(bar)) <= QUIET_BODY && rangePct(bar) <= QUIET_RANGE;
}

function isImpulseBar(bar: TenSecBar): boolean {
  return Math.abs(bodyPct(bar)) >= IMPULSE_BODY && isMoving10s(bar);
}

export function quietBaseWindow(bars: TenSecBar[], lookback = 10): TenSecBar[] {
  if (bars.length < 2) return [];
  const prior = bars.slice(0, -1).slice(-lookback);
  const quiet: TenSecBar[] = [];
  for (let i = prior.length - 1; i >= 0; i--) {
    const b = prior[i]!;
    if (!isQuietBar(b)) break;
    quiet.unshift(b);
  }
  return quiet;
}

/**
 * Quiet consolidation then first breakout bar in impulse direction.
 * Returns null when no quiet base / not first impulse / already oversized bar.
 */
export function decideEntryFromQuietImpulse(bars: TenSecBar[]): RegimeEntry | null {
  if (bars.length < MIN_QUIET_BARS + 1) return null;
  const impulse = bars[bars.length - 1]!;
  const base = quietBaseWindow(bars, 10);
  if (base.length < MIN_QUIET_BARS) return null;
  if (!isImpulseBar(impulse)) return null;

  const bp = bodyPct(impulse);
  if (Math.abs(bp) >= LATE_IMPULSE_BODY) {
    return null; // first closed bar already ran too far — do not chase
  }

  const baseHigh = Math.max(...base.map((b) => b.high));
  const baseLow = Math.min(...base.map((b) => b.low));
  const baseMid =
    base.reduce((s, b) => s + b.close, 0) / Math.max(base.length, 1);

  const candle = `10s O=${impulse.open.toFixed(2)} C=${impulse.close.toFixed(2)} body=${(
    bp * 100
  ).toFixed(3)}% · quiet×${base.length} @${baseMid.toFixed(2)}`;

  // First impulse UP from base — break above quiet highs
  if (bp > 0 && impulse.close > baseHigh && impulse.close > impulse.open) {
    return {
      direction: 'BUY',
      setup: 'BREAKOUT',
      reason: `QUIET→IMPULSE long · ${candle}`,
    };
  }

  // First impulse DOWN from base — break below quiet lows
  if (bp < 0 && impulse.close < baseLow && impulse.close < impulse.open) {
    return {
      direction: 'SELL',
      setup: 'BREAKOUT',
      reason: `QUIET→IMPULSE short · ${candle}`,
    };
  }

  return null;
}

export type EntryMode = 'quiet_impulse' | 'classic';

export function resolveEntryMode(raw?: string | null): EntryMode {
  const v = String(raw || process.env.VS_ENTRY_MODE || 'quiet_impulse')
    .trim()
    .toLowerCase();
  return v === 'classic' ? 'classic' : 'quiet_impulse';
}

/** Seconds to wait after any close before next entry (chop anti-spam). Env override. */
export function resolvePostExitCooldownMs(raw?: string | null): number {
  const source = raw === undefined ? process.env.VS_POST_EXIT_COOLDOWN_MS : raw;
  if (source == null || String(source).trim() === '') return 150_000;
  const n = Number(source);
  if (!Number.isFinite(n) || n < 0) return 150_000;
  return Math.min(Math.max(n, 0), 600_000);
}
