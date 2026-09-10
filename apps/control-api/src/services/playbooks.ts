/** Playbooks: regime picks the book; book owns entry + exit policy. */
import type { RegimeName } from './regimes.js';
import { normalizeRegime } from './regimes.js';
import type { TenSecBar } from './tenSecondOhlc.js';
import { bodyPct, rangePct } from './tenSecondOhlc.js';

export const PLAYBOOKS = ['LONG', 'SCALP', 'FADE', 'WAIT'] as const;
export type Playbook = (typeof PLAYBOOKS)[number];
export type TradePlaybook = Exclude<Playbook, 'WAIT'>;

export type ExitSide = 'BUY' | 'SELL';

/**
 * #314 base + user exit knobs:
 * - PeakProtect 75% retention for ALL regimes (max 25% MFE giveback)
 * - HardInv capped in absolute Gold points (pct alone ≈11pt → fat losses)
 * - TP floors ≫ SL caps so average win > average loss
 */
export const MAX_MFE_GIVEBACK = 0.25;
export const MIN_MFE_RETENTION = 0.75;
/** Harvest disabled (= PeakProtect) — single 75% lock */
export const HARVEST_MFE_RETENTION = 0.75;

export type PlaybookExitParams = {
  /** Target as fraction of entry price */
  tpPct: number;
  tpFloor: number;
  /** Soft HardInvalidation */
  slPct: number;
  slFloor: number;
  /** Cap soft SL in absolute price points (Gold safety) */
  slCapAbs: number;
  mfeFloorPct: number;
  mfeFloorAbs: number;
  /** PeakProtect when retention below this */
  peakRet: number;
  /** Harvest when retention below this and fav > 0 */
  harvestRet: number;
  thesisMinHoldMs: number;
  timeDecayMs: number;
};

/** PeakProtect 75% all books; HardInv ~1.35–1.45pt (BE early-exit covers flat scratches).
 * PeakProtect arms after a real leg (~2pt CONTINUATION / ~1.5pt FADE) — not 0.3pt noise. */
export const PLAYBOOK_EXIT: Record<TradePlaybook, PlaybookExitParams> = {
  LONG: {
    tpPct: 0.0028,
    tpFloor: 6.0,
    slPct: 0.00032,
    slFloor: 1.15,
    slCapAbs: 1.45,
    mfeFloorPct: 0.00045,
    mfeFloorAbs: 2.0,
    peakRet: MIN_MFE_RETENTION,
    harvestRet: HARVEST_MFE_RETENTION,
    thesisMinHoldMs: 120_000,
    timeDecayMs: 480_000,
  },
  SCALP: {
    tpPct: 0.0022,
    tpFloor: 5.0,
    slPct: 0.0003,
    slFloor: 1.05,
    slCapAbs: 1.35,
    mfeFloorPct: 0.0004,
    mfeFloorAbs: 1.8,
    peakRet: MIN_MFE_RETENTION,
    harvestRet: HARVEST_MFE_RETENTION,
    thesisMinHoldMs: 90_000,
    timeDecayMs: 480_000,
  },
  FADE: {
    tpPct: 0.0018,
    tpFloor: 4.0,
    slPct: 0.00028,
    slFloor: 0.95,
    slCapAbs: 1.25,
    mfeFloorPct: 0.00035,
    mfeFloorAbs: 1.5,
    peakRet: MIN_MFE_RETENTION,
    harvestRet: HARVEST_MFE_RETENTION,
    thesisMinHoldMs: 90_000,
    timeDecayMs: 240_000,
  },
};

/** Entry body — closed 10s must be a real Gold move (not a half-point chase). */
export const PLAYBOOK_ENTRY_BODY: Record<TradePlaybook, number> = {
  LONG: 0.00028, // ~1.2pt Gold @ 4400
  SCALP: 0.00024, // ~1.05pt
  FADE: 0.0002, // ~0.9pt bounce/reject
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

/** Manage exit — PeakProtect 75%; HardInv ~1.45pt (BE covers flat scratches); TP ≫ SL. */
export function exitParamsForTrade(
  playbook: TradePlaybook,
  entrySetup?: string | null
): PlaybookExitParams {
  const base = PLAYBOOK_EXIT[playbook];
  const setup = String(entrySetup || '').trim().toUpperCase();

  // V-bounce / dump continuation — hold for the leg; PeakProtect after ~2.5pt MFE
  if (setup === 'CONTINUATION' || setup === 'PULLBACK' || setup === 'BREAKOUT') {
    return {
      ...base,
      tpPct: 0.0025,
      tpFloor: 6.5,
      slPct: 0.00032,
      slFloor: 1.15,
      slCapAbs: 1.45,
      mfeFloorPct: 0.00055,
      mfeFloorAbs: 2.5,
      peakRet: MIN_MFE_RETENTION,
      harvestRet: HARVEST_MFE_RETENTION,
      thesisMinHoldMs: 180_000,
      timeDecayMs: 600_000,
    };
  }

  // FADE / failed-break bounce — still 75% PeakProtect, slightly wider HardInv
  if (setup === 'FADE' || setup === 'FAILED_BREAK') {
    return {
      ...base,
      tpPct: 0.0018,
      tpFloor: 4.0,
      slPct: 0.0003,
      slFloor: 1.05,
      slCapAbs: 1.35,
      mfeFloorPct: 0.00035,
      mfeFloorAbs: 1.5,
      peakRet: MIN_MFE_RETENTION,
      harvestRet: HARVEST_MFE_RETENTION,
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
