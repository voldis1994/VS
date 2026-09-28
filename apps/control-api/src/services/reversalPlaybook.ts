/**
 * Reversal playbook — for V-spike / wick-flip markets (not TREND pullback).
 *
 * Goals vs old REVERSAL_CANDIDATE both-way scalp:
 * 1) One bias from the violent flip bar (down impulse → only SELL, up → only BUY)
 * 2) Never chase the spike impulse itself — wait for a quieter confirm 10s
 * 3) Prefer correct zone half (SELL upper / BUY lower)
 * 4) Structure dies if price reclaims mid against the reverse
 */
import { ENTRY_DIP, ENTRY_RALLY, REVERSAL, TREND_ENTER } from './regimeBands.js';
import {
  bodyPct,
  isMoving10s,
  isSpike10s,
  rangePct,
  type TenSecBar,
} from './tenSecondOhlc.js';

export type ReversalBias = 'BUY' | 'SELL';

export type ReversalEntry = {
  direction: ReversalBias;
  setup: 'REVERSAL';
  reason: string;
};

/** Last violent bar (≥ REVERSAL body) sets the reverse bias. */
export function reversalBiasFromBars(
  bars: Array<Pick<TenSecBar, 'open' | 'close'>> | null | undefined
): ReversalBias | null {
  if (!bars?.length) return null;
  const look = bars.slice(-8);
  let best: { abs: number; dir: ReversalBias } | null = null;
  for (const b of look) {
    const bp = bodyPct(b);
    const abs = Math.abs(bp);
    if (abs < REVERSAL) continue;
    const dir: ReversalBias = bp < 0 ? 'SELL' : 'BUY';
    if (!best || abs > best.abs) best = { abs, dir };
  }
  return best?.dir ?? null;
}

/**
 * Two-bar V-flip: prior strong one way, current violent opposite.
 * Catches wick reversals even when prior regime was RANGE/EXPANSION.
 * `avgRange` ≤ 0 skips the range expansion check (body thresholds alone).
 */
export function isViolentVFlip(
  prev: Pick<TenSecBar, 'open' | 'high' | 'low' | 'close'> | null | undefined,
  last: Pick<TenSecBar, 'open' | 'high' | 'low' | 'close'> | null | undefined,
  avgRange: number
): boolean {
  if (!prev || !last) return false;
  const prevVel = bodyPct(prev);
  const lastVel = bodyPct(last);
  const lastRng = rangePct(last);
  if (avgRange > 0 && !(lastRng > avgRange)) return false;
  const downThenUp = prevVel <= -TREND_ENTER && lastVel >= REVERSAL;
  const upThenDown = prevVel >= TREND_ENTER && lastVel <= -REVERSAL;
  return downThenUp || upThenDown;
}

function describe(bar: TenSecBar): string {
  return `10s O=${bar.open.toFixed(2)} C=${bar.close.toFixed(2)} body=${(bodyPct(bar) * 100).toFixed(3)}% rng=${(rangePct(bar) * 100).toFixed(3)}%`;
}

/**
 * Soft PROFIT-style entry for REVERSAL_CANDIDATE.
 * - Bias only (no flip-flop both ways)
 * - Spike impulse → WAIT (confirm on next quieter bar)
 * - MOVING confirm in bias direction
 */
export function decideReversalEntry(
  bar: TenSecBar,
  closedBars?: TenSecBar[] | null,
  zonePos?: number | null
): ReversalEntry | null {
  const book = closedBars?.length ? [...closedBars, bar] : [bar];
  // Prefer bias from closed book (impulse already printed); fall back to including bar
  const bias =
    reversalBiasFromBars(closedBars?.length ? closedBars : book) ??
    reversalBiasFromBars(book);
  if (!bias) return null;

  // Never chase the violent spike — Soft eats the wick bounce
  if (isSpike10s(bar)) return null;
  if (!isMoving10s(bar)) return null;

  const bp = bodyPct(bar);
  const candle = describe(bar);

  if (bias === 'SELL') {
    if (bp > ENTRY_DIP) return null; // need red/flat-down confirm
    // Prefer upper / mid-hi — not chasing LO flush
    if (zonePos != null && Number.isFinite(zonePos) && zonePos < 0.35) {
      return null;
    }
    return {
      direction: 'SELL',
      setup: 'REVERSAL',
      reason: `REVERSAL SELL confirm · bias from violent flip · ${candle}`,
    };
  }

  // bias BUY
  if (bp < ENTRY_RALLY) return null;
  if (zonePos != null && Number.isFinite(zonePos) && zonePos > 0.65) {
    return null;
  }
  return {
    direction: 'BUY',
    setup: 'REVERSAL',
    reason: `REVERSAL BUY confirm · bias from violent flip · ${candle}`,
  };
}

/** Structure gate helper — only bias side; no extreme chase. */
export function reversalStructureAllows(
  direction: 'BUY' | 'SELL',
  bias: ReversalBias | null,
  zonePos: number | null | undefined,
  minuteDir: 'UP' | 'DOWN' | 'FLAT' | null
): { ok: true; tag: string } | { ok: false; reason: string } {
  if (bias && direction !== bias) {
    return {
      ok: false,
      reason: `REVERSAL only ${bias} (violent flip bias) · blocked ${direction}`,
    };
  }
  if (direction === 'BUY' && zonePos != null && zonePos >= 0.9 && minuteDir === 'UP') {
    return { ok: false, reason: `REVERSAL BUY chase extreme HI` };
  }
  if (direction === 'SELL' && zonePos != null && zonePos <= 0.1 && minuteDir === 'DOWN') {
    return { ok: false, reason: `REVERSAL SELL chase extreme LO` };
  }
  return {
    ok: true,
    tag: `REVERSAL ${direction} OK · bias=${bias || '?'} pos=${zonePos != null ? zonePos.toFixed(2) : '—'}`,
  };
}
