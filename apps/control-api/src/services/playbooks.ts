/** Playbooks: regime picks the book; book owns entry + exit policy. */
import type { RegimeName } from './regimes.js';
import { normalizeRegime } from './regimes.js';
import { scaleExitFloors } from './instrumentScale.js';
import type { TenSecBar } from './tenSecondOhlc.js';
import { bodyPct, rangePct } from './tenSecondOhlc.js';

export const PLAYBOOKS = ['LONG', 'SCALP', 'FADE', 'WAIT'] as const;
export type Playbook = (typeof PLAYBOOKS)[number];
export type TradePlaybook = Exclude<Playbook, 'WAIT'>;

export type ExitSide = 'BUY' | 'SELL';

export type PlaybookExitParams = {
  /** Target as fraction of entry price */
  tpPct: number;
  tpFloor: number;
  /** Soft HardInvalidation */
  slPct: number;
  slFloor: number;
  mfeFloorPct: number;
  mfeFloorAbs: number;
  /** PeakProtect when retention below this */
  peakRet: number;
  /** Harvest when retention below this and fav > 0 */
  harvestRet: number;
  thesisMinHoldMs: number;
  timeDecayMs: number;
};

/** Exact set from the agreed playbook drawing. */
export const PLAYBOOK_EXIT: Record<TradePlaybook, PlaybookExitParams> = {
  LONG: {
    tpPct: 0.0035,
    tpFloor: 0.35,
    slPct: 0.0025,
    slFloor: 0.25,
    mfeFloorPct: 0.0018,
    mfeFloorAbs: 0.18,
    peakRet: 0.4,
    harvestRet: 0.55,
    thesisMinHoldMs: 120_000,
    timeDecayMs: 480_000,
  },
  SCALP: {
    tpPct: 0.0022,
    tpFloor: 0.22,
    slPct: 0.0019,
    slFloor: 0.19,
    mfeFloorPct: 0.0015,
    mfeFloorAbs: 0.28,
    peakRet: 0.42,
    harvestRet: 0.52,
    thesisMinHoldMs: 120_000,
    timeDecayMs: 540_000,
  },
  FADE: {
    tpPct: 0.0018,
    tpFloor: 0.18,
    slPct: 0.0018,
    slFloor: 0.18,
    mfeFloorPct: 0.0012,
    mfeFloorAbs: 0.12,
    peakRet: 0.5,
    harvestRet: 0.55,
    thesisMinHoldMs: 90_000,
    timeDecayMs: 240_000,
  },
};

/** Entry body — 10s Gold-friendly (was too strict → missed real 10s moves). */
export const PLAYBOOK_ENTRY_BODY: Record<TradePlaybook, number> = {
  LONG: 0.00018, // ~0.8pt Gold @ 4400
  SCALP: 0.00015, // ~0.65pt
  FADE: 0.00012, // ~0.55pt bounce/reject
};

/**
 * Diagnostic only — LIVE entry uses playbookFromSetup (marketSetup).
 * COMPRESSION/quiet → null (NONE), never a WAIT "regime playbook".
 */
export function playbookFromRegime(regime?: string | null): Playbook {
  const r = normalizeRegime(regime);
  if (r === 'COMPRESSION') return 'WAIT'; // legacy alias = no book; desk treats as NONE
  if (r === 'TREND_UP' || r === 'TREND_DOWN') return 'LONG';
  if (r === 'PULLBACK_UPTREND' || r === 'PULLBACK_DOWNTREND') return 'LONG';
  if (r === 'BREAKOUT_UP' || r === 'BREAKOUT_DOWN') return 'SCALP';
  if (r === 'EXPANSION' || r === 'REVERSAL_CANDIDATE') return 'SCALP';
  if (r === 'FAILED_BREAKOUT_UP' || r === 'FAILED_BREAKOUT_DOWN') return 'FADE';
  if (r === 'RANGE') return 'FADE';
  return 'WAIT';
}

/** Prefer setup playbook; never invent WAIT as a trading book. */
export function tradePlaybookOrNull(p?: Playbook | null): TradePlaybook | null {
  if (p === 'LONG' || p === 'SCALP' || p === 'FADE') return p;
  return null;
}

/** Manage exit tuned by locked entry setup — ride bounce/continuation, not +£0.07 scalp. */
export function exitParamsForTrade(
  playbook: TradePlaybook,
  entrySetup?: string | null,
  entryPrice?: number | null
): PlaybookExitParams {
  const px = entryPrice;
  const baseRaw = PLAYBOOK_EXIT[playbook];
  const base = { ...baseRaw, ...scaleExitFloors(px, baseRaw) };
  const setup = String(entrySetup || '').trim().toUpperCase();

  // Breakout / impulse leg — same wide hold as continuation (was falling through to tpFloor 0.22)
  if (setup === 'BREAKOUT' || setup === 'CONTINUATION' || setup === 'PULLBACK') {
    const leg = scaleExitFloors(px, { tpFloor: 4.0, slFloor: baseRaw.slFloor, mfeFloorAbs: 2.5 });
    return {
      ...base,
      tpPct: 0.0028,
      tpFloor: leg.tpFloor,
      slPct: base.slPct,
      slFloor: leg.slFloor,
      mfeFloorPct: 0.00055,
      mfeFloorAbs: leg.mfeFloorAbs,
      peakRet: 0.2,
      harvestRet: 0.28,
      thesisMinHoldMs: 240_000,
      timeDecayMs: 720_000,
    };
  }

  // FADE / failed-break bounce from low — still room to mid, not instant 0.18pt target
  if (setup === 'FADE' || setup === 'FAILED_BREAK') {
    const fade = scaleExitFloors(px, { tpFloor: 3.0, slFloor: baseRaw.slFloor, mfeFloorAbs: 1.8 });
    return {
      ...base,
      tpPct: 0.0022,
      tpFloor: fade.tpFloor,
      mfeFloorPct: 0.00045,
      mfeFloorAbs: fade.mfeFloorAbs,
      peakRet: 0.32,
      harvestRet: 0.42,
      thesisMinHoldMs: 120_000,
      timeDecayMs: 420_000,
    };
  }

  return base;
}

export function isLongFamily(regime?: string | null): boolean {
  const r = normalizeRegime(regime);
  return (
    r === 'TREND_UP' ||
    r === 'TREND_DOWN' ||
    r === 'PULLBACK_UPTREND' ||
    r === 'PULLBACK_DOWNTREND'
  );
}

export function wasRangeOrExpansion(regime?: string | null): boolean {
  const r = normalizeRegime(regime);
  return r === 'RANGE' || r === 'EXPANSION';
}

export function wasTrend(regime?: string | null): boolean {
  const r = normalizeRegime(regime);
  return r === 'TREND_UP' || r === 'TREND_DOWN';
}

/** Ride-the-leg entries — ignore 10s pullback regime noise on exit thesis. */
export function isLegRideSetup(entrySetup?: string | null): boolean {
  const s = String(entrySetup || '').trim().toUpperCase();
  return s === 'BREAKOUT' || s === 'CONTINUATION' || s === 'PULLBACK';
}

/** ThesisFailure — divided by playbook (not one list for all). */
export function thesisFailureForPlaybook(
  side: ExitSide,
  regime: string | null | undefined,
  playbook: TradePlaybook,
  entrySetup?: string | null
): string | null {
  const r = String(regime || '')
    .trim()
    .toUpperCase() as RegimeName | string;
  if (!r) return null;

  if (playbook === 'LONG') {
    // Only clear opposite trend / breakout — pullback against is still hold
    if (side === 'BUY') {
      if (r === 'TREND_DOWN' || r === 'BREAKOUT_DOWN') {
        return `ThesisFailure · LONG BUY vs ${r}`;
      }
    } else if (r === 'TREND_UP' || r === 'BREAKOUT_UP') {
      return `ThesisFailure · LONG SELL vs ${r}`;
    }
    return null;
  }

  if (playbook === 'SCALP') {
    if (isLegRideSetup(entrySetup)) {
      if (side === 'BUY') {
        if (r === 'TREND_DOWN' || r === 'BREAKOUT_DOWN') {
          return `ThesisFailure · SCALP leg BUY vs ${r}`;
        }
      } else if (r === 'TREND_UP' || r === 'BREAKOUT_UP') {
        return `ThesisFailure · SCALP leg SELL vs ${r}`;
      }
      return null;
    }
    if (side === 'BUY') {
      if (
        r === 'TREND_DOWN' ||
        r === 'BREAKOUT_DOWN' ||
        r === 'PULLBACK_DOWNTREND' ||
        r === 'FAILED_BREAKOUT_UP'
      ) {
        return `ThesisFailure · SCALP BUY vs ${r}`;
      }
    } else if (
      r === 'TREND_UP' ||
      r === 'BREAKOUT_UP' ||
      r === 'PULLBACK_UPTREND' ||
      r === 'FAILED_BREAKOUT_DOWN'
    ) {
      return `ThesisFailure · SCALP SELL vs ${r}`;
    }
    return null;
  }

  // FADE — breakout or trend against the fade kills it
  if (side === 'BUY') {
    if (r === 'TREND_DOWN' || r === 'BREAKOUT_DOWN') {
      return `ThesisFailure · FADE BUY vs ${r}`;
    }
  } else if (r === 'TREND_UP' || r === 'BREAKOUT_UP') {
    return `ThesisFailure · FADE SELL vs ${r}`;
  }
  return null;
}

/** RANGE fade only near prior window high/low (not mid-range noise). */
export function nearRangeEdge(
  bar: TenSecBar,
  priorBars: TenSecBar[],
  edge: 'low' | 'high'
): boolean {
  if (!priorBars.length) return false;
  const hi = Math.max(...priorBars.map((b) => b.high));
  const lo = Math.min(...priorBars.map((b) => b.low));
  const span = Math.max(hi - lo, Math.abs(bar.close) * 1e-6);
  const eps = Math.max(Math.abs(bar.close) * 0.0003, span * 0.15);
  if (edge === 'low') return bar.close <= lo + eps;
  return bar.close >= hi - eps;
}

export function bodyStrongEnough(bar: TenSecBar, playbook: TradePlaybook): boolean {
  return Math.abs(bodyPct(bar)) >= PLAYBOOK_ENTRY_BODY[playbook];
}

export function dipFor(bar: TenSecBar, playbook: TradePlaybook): boolean {
  return bodyPct(bar) <= -PLAYBOOK_ENTRY_BODY[playbook];
}

export function rallyFor(bar: TenSecBar, playbook: TradePlaybook): boolean {
  return bodyPct(bar) >= PLAYBOOK_ENTRY_BODY[playbook];
}

/** Soft moving check — also allow playbook body alone. */
export function movingFor(bar: TenSecBar, playbook: TradePlaybook): boolean {
  return (
    Math.abs(bodyPct(bar)) >= PLAYBOOK_ENTRY_BODY[playbook] ||
    rangePct(bar) >= PLAYBOOK_ENTRY_BODY[playbook] * 1.5
  );
}
