/** 10s OHLC + playbook entry — regime picks LONG / SCALP / FADE / WAIT. */
import type { RegimeName } from './regimes.js';
import { normalizeRegime } from './regimes.js';
import { bodyPct, rangePct, type TenSecBar } from './tenSecondOhlc.js';
import {
  bodyStrongEnough,
  dipFor,
  movingFor,
  nearRangeEdge,
  playbookFromRegime,
  rallyFor,
  wasTrend,
  PLAYBOOK_ENTRY_BODY,
  type Playbook,
  type TradePlaybook,
} from './playbooks.js';
import {
  nearRealZoneEdge,
  type MarketZoneBook,
} from './structureZones.js';

export type RegimeEntry = {
  direction: 'BUY' | 'SELL';
  setup: 'CONTINUATION' | 'PULLBACK' | 'BREAKOUT' | 'FADE' | 'REVERSAL';
  playbook: TradePlaybook;
  reason: string;
};

export type EntryContext = {
  /** Consecutive closed bars in the current regime name */
  regimeAgeBars?: number;
  /** Consecutive bars in the same playbook family (LONG/SCALP/FADE) */
  playbookAgeBars?: number;
  previousRegime?: string | null;
  /** Prior closed bars (excluding the signal bar) — fallback micro edge */
  priorBars?: TenSecBar[];
  /** Real Capital minute zones — preferred for FADE edges + trend follow */
  zones?: MarketZoneBook | null;
};

function describe(bar: TenSecBar): string {
  return `10s O=${bar.open.toFixed(2)} C=${bar.close.toFixed(2)} body=${(bodyPct(bar) * 100).toFixed(3)}% rng=${(rangePct(bar) * 100).toFixed(3)}%`;
}

function familyAgeOk(ctx: EntryContext | undefined, need: number): boolean {
  return (ctx?.playbookAgeBars ?? ctx?.regimeAgeBars ?? 0) >= need;
}

/**
 * Visible 10s move → open a trade (SCALP). Used when playbook/zones would
 * otherwise sit idle while price is clearly dumping or rallying.
 */
export function decideMoveEntry(bar: TenSecBar): RegimeEntry | null {
  const thr = PLAYBOOK_ENTRY_BODY.SCALP;
  const body = bodyPct(bar);
  const candle = describe(bar);
  if (body >= thr) {
    return {
      direction: 'BUY',
      setup: 'BREAKOUT',
      playbook: 'SCALP',
      reason: `MOVE · rally open BUY · ${candle}`,
    };
  }
  if (body <= -thr) {
    return {
      direction: 'SELL',
      setup: 'BREAKOUT',
      playbook: 'SCALP',
      reason: `MOVE · dump open SELL · ${candle}`,
    };
  }
  return null;
}

/**
 * Live mid vs 1m zone H/L (or recent refs) — timing only, not a naked candle chase.
 * thr ~0.02% (~0.9pt Gold).
 */
export function decidePriceMove(
  mid: number,
  refHigh: number | null | undefined,
  refLow: number | null | undefined,
  thr = 0.0002
): RegimeEntry | null {
  if (!Number.isFinite(mid)) return null;
  if (refHigh != null && Number.isFinite(refHigh) && refHigh > 0) {
    const drop = (mid - refHigh) / Math.abs(refHigh);
    if (drop <= -thr) {
      return {
        direction: 'SELL',
        setup: 'BREAKOUT',
        playbook: 'SCALP',
        reason: `MOVE · mid dump vs H${refHigh.toFixed(2)} (${(drop * 100).toFixed(3)}%)`,
      };
    }
  }
  if (refLow != null && Number.isFinite(refLow) && refLow > 0) {
    const rise = (mid - refLow) / Math.abs(refLow);
    if (rise >= thr) {
      return {
        direction: 'BUY',
        setup: 'BREAKOUT',
        playbook: 'SCALP',
        reason: `MOVE · mid rally vs L${refLow.toFixed(2)} (${(rise * 100).toFixed(3)}%)`,
      };
    }
  }
  return null;
}

/** @deprecated tick noise — do not use for live entry */
export function decideTickMove(
  mid: number,
  prevMid: number | null | undefined,
  thr = 0.00025
): RegimeEntry | null {
  if (prevMid == null || !Number.isFinite(prevMid) || !Number.isFinite(mid) || prevMid === 0) {
    return null;
  }
  const rel = (mid - prevMid) / Math.abs(prevMid);
  if (rel <= -thr) {
    return {
      direction: 'SELL',
      setup: 'BREAKOUT',
      playbook: 'SCALP',
      reason: `MOVE · tick dump ${(rel * 100).toFixed(3)}%`,
    };
  }
  if (rel >= thr) {
    return {
      direction: 'BUY',
      setup: 'BREAKOUT',
      playbook: 'SCALP',
      reason: `MOVE · tick rally ${(rel * 100).toFixed(3)}%`,
    };
  }
  return null;
}

/** Playbook/setup from 1m zones side + optional 10s regime. */
export function labelPlaybookForMove(
  direction: 'BUY' | 'SELL',
  regime?: string | null,
  zonePlaybook?: 'LONG' | 'SCALP' | 'FADE' | 'WAIT' | null
): { playbook: TradePlaybook; setup: RegimeEntry['setup'] } {
  if (zonePlaybook === 'LONG') {
    return { playbook: 'LONG', setup: 'CONTINUATION' };
  }
  if (zonePlaybook === 'FADE') {
    return { playbook: 'FADE', setup: 'FADE' };
  }
  if (zonePlaybook === 'SCALP') {
    return { playbook: 'SCALP', setup: 'BREAKOUT' };
  }
  const book = playbookFromRegime(regime);
  if (book === 'LONG') return { playbook: 'LONG', setup: 'CONTINUATION' };
  if (book === 'FADE') return { playbook: 'FADE', setup: 'FADE' };
  const r = normalizeRegime(regime);
  if (r === 'REVERSAL_CANDIDATE') return { playbook: 'SCALP', setup: 'REVERSAL' };
  return { playbook: 'SCALP', setup: 'BREAKOUT' };
}

/**
 * Suitable entry for the current 10s regime via playbook rules.
 * Returns null = no playbook fit (caller may still use decideMoveEntry).
 */
export function decideEntryFrom10sRegime(
  bar: TenSecBar,
  regime?: string | null,
  ctx?: EntryContext
): RegimeEntry | null {
  const r: RegimeName = normalizeRegime(regime);
  const book: Playbook = playbookFromRegime(r);
  const candle = describe(bar);

  if (book === 'WAIT') return null;

  if (book === 'LONG') {
    if (!familyAgeOk(ctx, 1)) return null;
    if (!movingFor(bar, 'LONG') || !bodyStrongEnough(bar, 'LONG')) return null;

    if (r === 'TREND_UP') {
      if (dipFor(bar, 'LONG')) {
        return {
          direction: 'BUY',
          setup: 'PULLBACK',
          playbook: 'LONG',
          reason: `LONG · ${r} dip-buy · ${candle}`,
        };
      }
      // Impulse follow — open BUY on rally (do not require zones again)
      if (rallyFor(bar, 'LONG')) {
        return {
          direction: 'BUY',
          setup: 'CONTINUATION',
          playbook: 'LONG',
          reason: `LONG · ${r} trend-follow · ${candle}`,
        };
      }
      return null;
    }
    if (r === 'TREND_DOWN') {
      if (rallyFor(bar, 'LONG')) {
        return {
          direction: 'SELL',
          setup: 'PULLBACK',
          playbook: 'LONG',
          reason: `LONG · ${r} rally-sell · ${candle}`,
        };
      }
      if (dipFor(bar, 'LONG')) {
        return {
          direction: 'SELL',
          setup: 'CONTINUATION',
          playbook: 'LONG',
          reason: `LONG · ${r} trend-follow · ${candle}`,
        };
      }
      return null;
    }
    if (r === 'PULLBACK_UPTREND') {
      if (!rallyFor(bar, 'LONG')) return null;
      return {
        direction: 'BUY',
        setup: 'CONTINUATION',
        playbook: 'LONG',
        reason: `LONG · ${r} resume · ${candle}`,
      };
    }
    if (r === 'PULLBACK_DOWNTREND') {
      if (!dipFor(bar, 'LONG')) return null;
      return {
        direction: 'SELL',
        setup: 'CONTINUATION',
        playbook: 'LONG',
        reason: `LONG · ${r} resume · ${candle}`,
      };
    }
    return null;
  }

  if (book === 'SCALP') {
    if (!familyAgeOk(ctx, 1)) return null;
    if (!movingFor(bar, 'SCALP') || !bodyStrongEnough(bar, 'SCALP')) return null;

    if (r === 'BREAKOUT_UP') {
      if (!rallyFor(bar, 'SCALP')) return null;
      return {
        direction: 'BUY',
        setup: 'BREAKOUT',
        playbook: 'SCALP',
        reason: `SCALP · ${r} follow · ${candle}`,
      };
    }
    if (r === 'BREAKOUT_DOWN') {
      if (!dipFor(bar, 'SCALP')) return null;
      return {
        direction: 'SELL',
        setup: 'BREAKOUT',
        playbook: 'SCALP',
        reason: `SCALP · ${r} follow · ${candle}`,
      };
    }
    if (r === 'EXPANSION') {
      if (rallyFor(bar, 'SCALP')) {
        return {
          direction: 'BUY',
          setup: 'BREAKOUT',
          playbook: 'SCALP',
          reason: `SCALP · ${r} follow up · ${candle}`,
        };
      }
      if (dipFor(bar, 'SCALP')) {
        return {
          direction: 'SELL',
          setup: 'BREAKOUT',
          playbook: 'SCALP',
          reason: `SCALP · ${r} follow down · ${candle}`,
        };
      }
      return null;
    }
    if (r === 'REVERSAL_CANDIDATE') {
      if (dipFor(bar, 'SCALP')) {
        return {
          direction: 'SELL',
          setup: 'REVERSAL',
          playbook: 'SCALP',
          reason: `SCALP · ${r} · ${candle}`,
        };
      }
      if (rallyFor(bar, 'SCALP')) {
        return {
          direction: 'BUY',
          setup: 'REVERSAL',
          playbook: 'SCALP',
          reason: `SCALP · ${r} · ${candle}`,
        };
      }
      return null;
    }
    // Still dumping after failed break down → sell with the move (not fade-buy)
    if (r === 'FAILED_BREAKOUT_DOWN') {
      if (dipFor(bar, 'SCALP') || bodyPct(bar) < 0) {
        return {
          direction: 'SELL',
          setup: 'BREAKOUT',
          playbook: 'SCALP',
          reason: `SCALP · ${r} follow dump · ${candle}`,
        };
      }
      return null;
    }
    if (r === 'FAILED_BREAKOUT_UP') {
      if (rallyFor(bar, 'SCALP') || bodyPct(bar) > 0) {
        return {
          direction: 'BUY',
          setup: 'BREAKOUT',
          playbook: 'SCALP',
          reason: `SCALP · ${r} follow rally · ${candle}`,
        };
      }
      return null;
    }
    return null;
  }

  if (book === 'FADE') {
    if (wasTrend(ctx?.previousRegime) && (ctx?.regimeAgeBars ?? 0) <= 1) {
      return null;
    }
    if (!movingFor(bar, 'FADE') || !bodyStrongEnough(bar, 'FADE')) return null;

    if (r === 'RANGE') {
      const zones = ctx?.zones;
      const prior = ctx?.priorBars || [];
      const lowOk = zones?.ready
        ? nearRealZoneEdge(zones, 'low')
        : nearRangeEdge(bar, prior, 'low');
      const highOk = zones?.ready
        ? nearRealZoneEdge(zones, 'high')
        : nearRangeEdge(bar, prior, 'high');
      if (dipFor(bar, 'FADE')) {
        if (!lowOk) return null;
        return {
          direction: 'BUY',
          setup: 'FADE',
          playbook: 'FADE',
          reason: `FADE · ${r} zone-low · ${candle}`,
        };
      }
      if (rallyFor(bar, 'FADE')) {
        if (!highOk) return null;
        return {
          direction: 'SELL',
          setup: 'FADE',
          playbook: 'FADE',
          reason: `FADE · ${r} zone-high · ${candle}`,
        };
      }
      return null;
    }
    return null;
  }

  return null;
}
