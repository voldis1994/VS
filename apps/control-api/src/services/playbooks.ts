/** Playbooks: regime picks the book; book owns entry + exit policy. */
import type { RegimeName } from './regimes.js';
import { normalizeRegime } from './regimes.js';
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
    mfeFloorAbs: 0.15,
    peakRet: 0.55,
    harvestRet: 0.65,
    thesisMinHoldMs: 45_000,
    timeDecayMs: 480_000,
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
    thesisMinHoldMs: 60_000,
    timeDecayMs: 240_000,
  },
};

/** Entry body thresholds (fraction of price). */
export const PLAYBOOK_ENTRY_BODY: Record<TradePlaybook, number> = {
  LONG: 0.00035, // 0.035% — was 0.05%, missed smaller Gold 10s bodies
  SCALP: 0.00022, // 0.022%
  FADE: 0.0002, // 0.02%
};

export function playbookFromRegime(regime?: string | null): Playbook {
  const r = normalizeRegime(regime);
  // Only true quiet — never UNKNOWN/TRANSITION (those are gone)
  if (r === 'COMPRESSION') return 'WAIT';
  if (r === 'TREND_UP' || r === 'TREND_DOWN') return 'LONG';
  if (r === 'PULLBACK_UPTREND' || r === 'PULLBACK_DOWNTREND') return 'LONG';
  if (r === 'BREAKOUT_UP' || r === 'BREAKOUT_DOWN') return 'SCALP';
  if (r === 'EXPANSION' || r === 'REVERSAL_CANDIDATE') return 'SCALP';
  if (r === 'RANGE' || r === 'FAILED_BREAKOUT_UP' || r === 'FAILED_BREAKOUT_DOWN') return 'FADE';
  return 'WAIT';
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

/** ThesisFailure — divided by playbook (not one list for all). */
export function thesisFailureForPlaybook(
  side: ExitSide,
  regime: string | null | undefined,
  playbook: TradePlaybook
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
