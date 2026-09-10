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
 * Exit R:R (#314 PeakProtect lineage + #198 75% lock):
 * - Winners: PeakProtect @75% retention for ALL regimes (max 25% MFE giveback).
 * - Losers: HardInv capped ≈1.0pt (tighter than prior ≈1.5–1.6).
 * - Targets ≫ HardInv so average win > average loss when TP hits.
 */
export const MAX_MFE_GIVEBACK = 0.25;
/** Keep ≥75% of MFE — unified PeakProtect for LONG/SCALP/FADE + setup overrides */
export const MIN_MFE_RETENTION = 0.75;
export const TIGHT_MFE_RETENTION = 0.75;
/** Harvest band disabled (= PeakProtect) — 75% lock is the only giveback cut */
export const HARVEST_MFE_RETENTION = 0.75;

export type PlaybookExitParams = {
  /** Target as fraction of entry price */
  tpPct: number;
  tpFloor: number;
  /** Soft HardInvalidation */
  slPct: number;
  slFloor: number;
  /**
   * Cap soft SL in absolute price points.
   * Without this, Gold @4400 × 0.18% ≈ 8pt → fat −£1 losses while wins scalp at +£0.17.
   */
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

/** Base books — CONTINUATION override owns live Gold legs. */
export const PLAYBOOK_EXIT: Record<TradePlaybook, PlaybookExitParams> = {
  LONG: {
    tpPct: 0.0028,
    tpFloor: 6.0,
    slPct: 0.00028,
    slFloor: 0.85,
    slCapAbs: 1.0,
    mfeFloorPct: 0.00055,
    mfeFloorAbs: 2.5,
    peakRet: MIN_MFE_RETENTION,
    harvestRet: HARVEST_MFE_RETENTION,
    thesisMinHoldMs: 90_000,
    timeDecayMs: 600_000,
  },
  SCALP: {
    tpPct: 0.0022,
    tpFloor: 5.0,
    slPct: 0.00025,
    slFloor: 0.8,
    slCapAbs: 0.95,
    mfeFloorPct: 0.0005,
    mfeFloorAbs: 2.5,
    peakRet: MIN_MFE_RETENTION,
    harvestRet: HARVEST_MFE_RETENTION,
    thesisMinHoldMs: 75_000,
    timeDecayMs: 480_000,
  },
  FADE: {
    tpPct: 0.0018,
    tpFloor: 4.0,
    slPct: 0.00022,
    slFloor: 0.7,
    slCapAbs: 0.9,
    mfeFloorPct: 0.00045,
    mfeFloorAbs: 2.2,
    peakRet: MIN_MFE_RETENTION,
    harvestRet: HARVEST_MFE_RETENTION,
    thesisMinHoldMs: 60_000,
    timeDecayMs: 300_000,
  },
};

/** Entry body — real 10s move, not so strict that desk never arms. */
export const PLAYBOOK_ENTRY_BODY: Record<TradePlaybook, number> = {
  LONG: 0.0002, // ~0.9pt Gold @ 4400
  SCALP: 0.00018, // ~0.8pt
  FADE: 0.00015,
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

/** Manage exit — PeakProtect 75% all regimes; HardInv ≈1.0pt; TP ≫ SL. */
export function exitParamsForTrade(
  playbook: TradePlaybook,
  entrySetup?: string | null
): PlaybookExitParams {
  const base = PLAYBOOK_EXIT[playbook];
  const setup = String(entrySetup || '').trim().toUpperCase();

  // Live with-move legs — hold for the move (MFE ≥2.5pt before trail), cut losers ≈1.0pt
  if (setup === 'CONTINUATION' || setup === 'PULLBACK' || setup === 'BREAKOUT') {
    return {
      ...base,
      tpPct: 0.0025,
      tpFloor: 6.5,
      slPct: 0.00028,
      slFloor: 0.85,
      slCapAbs: 1.0,
      mfeFloorPct: 0.00055,
      mfeFloorAbs: 2.5,
      peakRet: MIN_MFE_RETENTION,
      harvestRet: HARVEST_MFE_RETENTION,
      thesisMinHoldMs: 90_000,
      timeDecayMs: 720_000,
    };
  }

  // Legacy FADE — tight cut, still 75% PeakProtect
  if (setup === 'FADE' || setup === 'FAILED_BREAK') {
    return {
      ...base,
      tpPct: 0.0018,
      tpFloor: 4.0,
      slPct: 0.00025,
      slFloor: 0.8,
      slCapAbs: 1.0,
      mfeFloorPct: 0.0004,
      mfeFloorAbs: 2.0,
      peakRet: MIN_MFE_RETENTION,
      harvestRet: HARVEST_MFE_RETENTION,
      thesisMinHoldMs: 30_000,
      timeDecayMs: 240_000,
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
