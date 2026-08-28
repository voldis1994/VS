/**
 * Trader vision — see the market like a chart reader, not only net-pt math.
 * Uses own 10s OHLC: swing high/low, range position, climax, momentum fade.
 */
import type { TenSecBar } from './tenSecondOhlc.js';
import { bodyPct, rangePct } from './tenSecondOhlc.js';

const BARS_5M = 30;
const BARS_1M = 6;
const BARS_90S = 9;
/** ~10 min range — trader eye on chart swing, not only last 5m window. */
const BARS_RANGE = 60;

/** Top/bottom 18% of 5m range ≈ swing extreme on chart. */
const SWING_EXTREME_PCT = 0.18;
/** Upper/lower band before mid. */
const UPPER_BAND = 0.72;
const LOWER_BAND = 0.28;

/** ~0.12% body ≈ 5.5pt Gold — move already printed on chart. */
const LATE_BAR_BODY_PCT = 0.0012;

function signalBarTooLate(bar: TenSecBar): boolean {
  return Math.abs(bodyPct(bar)) >= LATE_BAR_BODY_PCT;
}

export type TraderLocation = 'SWING_HIGH' | 'SWING_LOW' | 'UPPER' | 'LOWER' | 'MID';
export type TraderMomentum = 'PUSH' | 'FADE' | 'FLAT';

export type TraderMarketView = {
  price: number;
  high5m: number;
  low5m: number;
  range5m: number;
  /** 0 = at 5m low, 1 = at 5m high (like eyeballing the chart). */
  rangePos: number;
  pts5m: number;
  pts1m: number;
  pts90s: number;
  location: TraderLocation;
  momentum: TraderMomentum;
  climaxUp: boolean;
  climaxDown: boolean;
  stillExtendingUp: boolean;
  stillExtendingDown: boolean;
  narrative: string;
};

function withLive(
  bars: TenSecBar[] | null | undefined,
  liveBar?: TenSecBar | null
): TenSecBar[] {
  const all = [...(bars ?? [])];
  if (liveBar && Number.isFinite(liveBar.close)) {
    const last = all[all.length - 1];
    if (!last || last.open_time_ms !== liveBar.open_time_ms) all.push(liveBar);
    else all[all.length - 1] = liveBar;
  }
  return all;
}

function netPts(all: TenSecBar[], lookback: number): number {
  if (all.length < 2) return 0;
  const w = all.slice(-Math.max(lookback, 2));
  return w[w.length - 1]!.close - w[0]!.open;
}

function locate(rangePos: number): TraderLocation {
  if (rangePos >= 1 - SWING_EXTREME_PCT) return 'SWING_HIGH';
  if (rangePos <= SWING_EXTREME_PCT) return 'SWING_LOW';
  if (rangePos >= UPPER_BAND) return 'UPPER';
  if (rangePos <= LOWER_BAND) return 'LOWER';
  return 'MID';
}

function momentumOf(pts5m: number, pts1m: number, tailNet: number): TraderMomentum {
  if (Math.abs(pts5m) < 0.35) return 'FLAT';
  const up = pts5m > 0;
  if (up) {
    if (pts1m >= 0.15 && tailNet >= 0.2) return 'PUSH';
    if (pts1m <= -0.05 || tailNet <= -0.15) return 'FADE';
  } else {
    if (pts1m <= -0.15 && tailNet <= -0.2) return 'PUSH';
    if (pts1m >= 0.05 || tailNet >= 0.15) return 'FADE';
  }
  return 'FLAT';
}

function isGreen(bar: TenSecBar): boolean {
  return bar.close > bar.open;
}

function isRed(bar: TenSecBar): boolean {
  return bar.close < bar.open;
}

/** Build the same picture a trader sees on a 5m window of 10s candles. */
export function buildTraderView(
  bars: TenSecBar[] | null | undefined,
  liveBar?: TenSecBar | null
): TraderMarketView | null {
  const all = withLive(bars, liveBar);
  if (all.length < 8) return null;

  const window = all.slice(-BARS_RANGE);
  const high5m = Math.max(...window.map((b) => b.high));
  const low5m = Math.min(...window.map((b) => b.low));
  const range5m = Math.max(high5m - low5m, 0.01);
  const bar = all[all.length - 1]!;
  const price = bar.close;
  const rangePos = Math.min(1, Math.max(0, (price - low5m) / range5m));

  const pts5m = netPts(all, BARS_5M);
  const pts1m = netPts(all, BARS_1M);
  const pts90s = netPts(all, BARS_90S);

  const tail = all.slice(-3);
  const tailNet = tail.length >= 2 ? tail[tail.length - 1]!.close - tail[0]!.open : 0;
  const momentum = momentumOf(pts5m, pts1m, tailNet);
  const location = locate(rangePos);

  const bigBody = Math.abs(bodyPct(bar)) >= 0.001;
  const climaxUp =
    isGreen(bar) &&
    rangePos >= 0.75 &&
    (signalBarTooLate(bar) || bigBody || (pts5m >= 2.5 && momentum === 'FADE'));
  const climaxDown =
    isRed(bar) &&
    rangePos <= 0.25 &&
    (signalBarTooLate(bar) || bigBody || (pts5m <= -2.5 && momentum === 'FADE'));

  const stillExtendingUp = tailNet >= 0.25;
  const stillExtendingDown = tailNet <= -0.25;

  const locTxt =
    location === 'SWING_HIGH'
      ? 'pie swing HIGH'
      : location === 'SWING_LOW'
        ? 'pie swing LOW'
        : location === 'UPPER'
          ? 'augšā range'
          : location === 'LOWER'
            ? 'lejā range'
            : 'range vidū';

  const momTxt =
    momentum === 'PUSH'
      ? 'impuls turpinās'
      : momentum === 'FADE'
        ? 'impuls blāvnē'
        : 'klusa';

  const narrative = `TRADER · ${price.toFixed(2)} · ${(rangePos * 100).toFixed(0)}% [${low5m.toFixed(1)}–${high5m.toFixed(1)}] · 5m ${pts5m >= 0 ? '+' : ''}${pts5m.toFixed(1)}pt · ${locTxt} · ${momTxt}${
    climaxUp ? ' · CLIMAX↑' : climaxDown ? ' · CLIMAX↓' : ''
  }`;

  return {
    price,
    high5m,
    low5m,
    range5m,
    rangePos,
    pts5m,
    pts1m,
    pts90s,
    location,
    momentum,
    climaxUp,
    climaxDown,
    stillExtendingUp,
    stillExtendingDown,
    narrative,
  };
}

export function formatTraderLine(view: TraderMarketView | null | undefined): string {
  return view?.narrative ?? 'TRADER · seeding OHLC';
}

/**
 * Entry gate — trader eyes, not blind net-pt BUY.
 * Blocks chase tops/bottoms; allows dip-buy / rally-sell like a human.
 */
export function traderEntryGate(
  direction: 'BUY' | 'SELL',
  view: TraderMarketView,
  bar: TenSecBar
): { ok: boolean; reason: string } {
  const { rangePos, pts5m, location, momentum, climaxUp, climaxDown, stillExtendingUp, stillExtendingDown } =
    view;

  if (direction === 'BUY') {
    if (rangePos >= 0.85 && pts5m >= 1.0) {
      return {
        ok: false,
        reason: `${view.narrative} · NO BUY · cena pie 5m HIGH (${(rangePos * 100).toFixed(0)}%)`,
      };
    }
    if (climaxUp) {
      return {
        ok: false,
        reason: `${view.narrative} · NO BUY · climax zaļa pie virsotnes`,
      };
    }
    if (
      (location === 'SWING_HIGH' || (location === 'UPPER' && rangePos >= 0.75)) &&
      pts5m >= 2.0 &&
      !stillExtendingUp
    ) {
      return {
        ok: false,
        reason: `${view.narrative} · NO BUY · chase top pēc +${pts5m.toFixed(1)}pt rally`,
      };
    }
    if (
      (location === 'SWING_HIGH' || rangePos >= 0.82) &&
      pts5m >= 2.0 &&
      momentum === 'FADE'
    ) {
      return {
        ok: false,
        reason: `${view.narrative} · NO BUY · rally beidzas pie HIGH`,
      };
    }
    if (signalBarTooLate(bar) && rangePos >= 0.7 && pts5m >= 1.2) {
      return {
        ok: false,
        reason: `${view.narrative} · NO BUY · liela svece augšā (move done)`,
      };
    }
    if (pts5m >= 0.35 && rangePos <= 0.72) {
      return {
        ok: true,
        reason: `${view.narrative} · OK BUY · ${rangePos < 0.45 ? 'dip/early' : 'room in range'}`,
      };
    }
    if (pts5m >= 0.35 && stillExtendingUp && rangePos < 0.65) {
      return { ok: true, reason: `${view.narrative} · OK BUY · vēl stiepjas · zem 65% range` };
    }
    return {
      ok: false,
      reason: `${view.narrative} · NO BUY · nav pullback / pārāk augstu`,
    };
  }

  if (direction === 'SELL') {
    if (rangePos <= 0.15 && pts5m <= -1.0) {
      return {
        ok: false,
        reason: `${view.narrative} · NO SELL · cena pie 5m LOW (${(rangePos * 100).toFixed(0)}%)`,
      };
    }
    if (climaxDown) {
      return {
        ok: false,
        reason: `${view.narrative} · NO SELL · climax sarkana pie dibena`,
      };
    }
    if (
      (location === 'SWING_LOW' || (location === 'LOWER' && rangePos <= 0.25)) &&
      pts5m <= -2.0 &&
      !stillExtendingDown
    ) {
      return {
        ok: false,
        reason: `${view.narrative} · NO SELL · chase bottom pēc ${pts5m.toFixed(1)}pt dump`,
      };
    }
    if (
      (location === 'SWING_LOW' || rangePos <= 0.18) &&
      pts5m <= -2.0 &&
      momentum === 'FADE'
    ) {
      return {
        ok: false,
        reason: `${view.narrative} · NO SELL · dump beidzas pie LOW`,
      };
    }
    if (signalBarTooLate(bar) && rangePos <= 0.3 && pts5m <= -1.2) {
      return {
        ok: false,
        reason: `${view.narrative} · NO SELL · liela svece lejā (move done)`,
      };
    }
    if (pts5m <= -0.35 && rangePos >= 0.28) {
      return {
        ok: true,
        reason: `${view.narrative} · OK SELL · ${rangePos > 0.55 ? 'bounce/early' : 'room in range'}`,
      };
    }
    if (pts5m <= -0.35 && stillExtendingDown && rangePos > 0.35) {
      return { ok: true, reason: `${view.narrative} · OK SELL · vēl stiepjas · virs 35% range` };
    }
    return {
      ok: false,
      reason: `${view.narrative} · NO SELL · nav bounce / pārāk zemu`,
    };
  }

  return { ok: false, reason: `${view.narrative} · NO ENTRY · unknown side` };
}
