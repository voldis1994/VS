/**
 * Runtime genome — thresholds the trading brain can evolve without touching lot/broker.
 * Decision code reads these via getBrainGenome(); self-improve mutates genome.json candidates.
 *
 * Micro price fractions (0.0008) are stored as **basis points** (8 bp). Convert live
 * with {@link regimeBpToFrac}. Min human step **0.1** bp — no 0.00008 dust.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type BrainGenome = {
  version: number;
  updated_at: string;
  /** Peak Keep fraction (0.65–0.88) */
  peak_keep: number;
  /** Soft-sized MFE mult before Peak trail arms (0.5–1.2) */
  peak_arm_soft_mult: number;
  /** Soft+ giveback bank threshold (0.55–0.85) */
  soft_plus_giveback: number;
  /** Require 1m agree with bias before PRĀTS entry */
  require_1m_trigger: boolean;
  /** After Soft same-side loss, pause that side for N closes */
  soft_same_side_pause_closes: number;
  /** Min Soft losses same side before pause arms */
  soft_same_side_pause_min: number;
  /** Multi-TF: treat 1m fight as WAIT (true) or allow side hold (false) */
  wait_on_1m_fight: boolean;
  /** Mind BANK when Soft+ and market turns (always on if true) */
  mind_bank_on_turn: boolean;
  /** Monotonic explore counter — always advances so learning never stalls */
  explore_step: number;
  /** Extra note from last accepted cycle */
  last_lesson: string;

  /** Shared 10s move floor bp (factory 0.8 ≡ 0.00008) */
  regime_move: number;
  /** Stay in existing trend bp */
  regime_trend_stay: number;
  /** Enter fresh trend bp */
  regime_trend_enter: number;
  /** Against-trend pullback body bp */
  regime_pullback: number;
  /** Violent reversal body bp */
  regime_reversal: number;
  /** isMoving range floor bp */
  regime_move_range: number;
  /** Compression absolute range bp */
  regime_compress_abs: number;
  /** Expansion absolute range bp */
  regime_expand_abs: number;
  /** Compression vs prior avg range mult */
  regime_compress_avg_mult: number;
  /** Expansion vs prior avg range mult */
  regime_expand_avg_mult: number;
  /** Compression near zone mid fraction */
  regime_near_zone_mid: number;
  /** Clear breakout pierce fraction of zone width */
  regime_clear_break_frac: number;
  /** Persistence to enter trend */
  regime_persist_enter: number;
  /** Persistence to stay in trend */
  regime_persist_stay: number;
  /** Persistence for pullback classify */
  regime_persist_pullback: number;
  /** Positive RANGE chop — |persistence| ≤ this */
  regime_range_chop_persist_max: number;
  /** Positive RANGE — |zoneTrek|/width ≤ this */
  regime_range_trek_share_max: number;
  /** Positive RANGE — trek efficiency ≤ this */
  regime_range_trek_eff_max: number;
  /** Soft regime switch dwell (10s bars) */
  regime_min_dwell_bars: number;
  /** Cross-family confirm bars after dwell */
  regime_confirm_bars: number;
  /** Momentum window length (10s bars) */
  regime_mom_bars: number;
  /** Persistence mean window inside mom */
  regime_persist_window: number;

  /** Trek flat if range < mid × (this bp → frac). Factory 4 bp ≡ 0.0004 */
  mtf_trek_flat_frac: number;

  /** Soft HardInv as bp of price (8 bp ≡ 0.0008) */
  hardinv_pct_bp: number;
  /** Peak MFE floor as bp of price (9 bp ≡ 0.0009) */
  peak_mfe_pct_bp: number;
  /** Target as bp of price (25 bp ≡ 0.0025) */
  target_pct_bp: number;

  /** STORY min path as bp (7 ≡ 0.0007) */
  story_min_path_bp: number;

  /** Regime ladder gap MOVE→STAY (bp) */
  gap_move_stay: number;
  /** Regime ladder gap STAY→ENTER (bp) */
  gap_stay_enter: number;
  /** Regime ladder gap ENTER→PULLBACK (bp) */
  gap_enter_pullback: number;
  /** Regime ladder gap PULLBACK→REVERSAL (bp) */
  gap_pullback_reversal: number;
  /** Regime ladder gap COMPRESS→EXPAND (bp) */
  gap_compress_expand: number;
  /** persist_enter − persist_stay min gap */
  persist_enter_stay_min_gap: number;
};

const DEFAULT_GENOME: BrainGenome = {
  version: 1,
  updated_at: new Date(0).toISOString(),
  peak_keep: 0.75,
  peak_arm_soft_mult: 1.0,
  soft_plus_giveback: 0.75,
  require_1m_trigger: true,
  soft_same_side_pause_closes: 4,
  /** First Soft arms pause — Soft spam governor is brain memory, not flipFilter hardcode */
  soft_same_side_pause_min: 1,
  wait_on_1m_fight: true,
  mind_bank_on_turn: true,
  explore_step: 0,
  last_lesson: 'factory genome',
  regime_move: 0.8,
  regime_trend_stay: 2.2,
  regime_trend_enter: 3.8,
  regime_pullback: 5.5,
  regime_reversal: 16,
  regime_move_range: 1.2,
  regime_compress_abs: 0.6,
  regime_expand_abs: 6,
  regime_compress_avg_mult: 0.35,
  regime_expand_avg_mult: 1.65,
  regime_near_zone_mid: 0.28,
  regime_clear_break_frac: 0.25,
  regime_persist_enter: 0.5,
  regime_persist_stay: 0.3,
  regime_persist_pullback: 0.2,
  regime_range_chop_persist_max: 0.25,
  regime_range_trek_share_max: 0.32,
  regime_range_trek_eff_max: 0.45,
  regime_min_dwell_bars: 5,
  regime_confirm_bars: 3,
  regime_mom_bars: 8,
  regime_persist_window: 6,
  mtf_trek_flat_frac: 4,
  hardinv_pct_bp: 8,
  peak_mfe_pct_bp: 9,
  target_pct_bp: 25,
  story_min_path_bp: 7,
  gap_move_stay: 1,
  gap_stay_enter: 1.2,
  gap_enter_pullback: 1.2,
  gap_pullback_reversal: 8,
  gap_compress_expand: 4,
  persist_enter_stay_min_gap: 0.05,
};

/** Genome keys Brain SI may evolve on the easy ACCEPT path (regime + pct bp). */
export const TRADING_INTEL_GENOME_KEYS: readonly (keyof BrainGenome)[] = [
  'regime_move',
  'regime_trend_stay',
  'regime_trend_enter',
  'regime_pullback',
  'regime_reversal',
  'regime_move_range',
  'regime_compress_abs',
  'regime_expand_abs',
  'regime_compress_avg_mult',
  'regime_expand_avg_mult',
  'regime_near_zone_mid',
  'regime_clear_break_frac',
  'regime_persist_enter',
  'regime_persist_stay',
  'regime_persist_pullback',
  'regime_range_chop_persist_max',
  'regime_range_trek_share_max',
  'regime_range_trek_eff_max',
  'regime_min_dwell_bars',
  'regime_confirm_bars',
  'regime_mom_bars',
  'regime_persist_window',
  'mtf_trek_flat_frac',
  'hardinv_pct_bp',
  'peak_mfe_pct_bp',
  'target_pct_bp',
  'story_min_path_bp',
];

function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../../');
}

export function genomePath(): string {
  const env = process.env.BRAIN_GENOME_PATH?.trim();
  if (env) return env;
  return path.join(repoRoot(), 'data', 'brain-self-improve', 'genome.json');
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function clampInt(raw: unknown, fb: number, lo: number, hi: number): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return fb;
  return Math.min(hi, Math.max(lo, n));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 1 bp = 0.0001 price fraction. */
export const REGIME_BP = 1e-4;

/** bp → price fraction for classify / isMoving / trek / Soft pct knobs. */
export function regimeBpToFrac(bp: number): number {
  return Math.max(0, Number(bp) || 0) * REGIME_BP;
}

/** Round to 1 decimal — min human step 0.1 (no 0.00008 dust → round-to-0). */
export function roundRegimeBp(n: number): number {
  return Math.round(clamp(n, 0.1, 1e6) * 10) / 10;
}

function bumpAbove(floor: number, gap: number): number {
  return roundRegimeBp(floor + gap);
}

/**
 * Legacy genome.json used price fractions (0.00008 / 0.0008).
 * New scale is bp (0.8 / 8). Detect fraction payloads and ×10000 once.
 */
function coerceRegimeBp(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  if (n > 0 && n < 0.05) return roundRegimeBp(n * 10_000);
  return roundRegimeBp(n);
}

/** Soft/Peak/Target pct micro → bp (0.0008 → 8). Also accepts already-bp values. */
function coerceMicroBp(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  if (n > 0 && n < 0.05) return roundRegimeBp(n * 10_000);
  return roundRegimeBp(n);
}

/**
 * Floor for Soft hardinv_pct_bp. Brain SI bounced to 0.1bp (= Soft suicide / dust).
 * Factory default is 8; never allow live genome below this.
 */
export const HARDINV_PCT_BP_MIN = 4;

function migrateLegacyKeys(p: Record<string, unknown>): void {
  if (p.hardinv_pct_bp == null && p.hardinv_pct != null) {
    p.hardinv_pct_bp = p.hardinv_pct;
  }
  if (p.peak_mfe_pct_bp == null && p.peak_mfe_pct != null) {
    p.peak_mfe_pct_bp = p.peak_mfe_pct;
  }
  if (p.target_pct_bp == null && p.target_pct != null) {
    p.target_pct_bp = p.target_pct;
  }
  if (p.story_min_path_bp == null && p.story_min_path_pct != null) {
    p.story_min_path_bp = p.story_min_path_pct;
  }
  if (p.mtf_trek_flat_frac != null) {
    const n = Number(p.mtf_trek_flat_frac);
    if (Number.isFinite(n) && n > 0 && n < 0.05) {
      p.mtf_trek_flat_frac = roundRegimeBp(n * 10_000);
    }
  }
  for (const k of [
    'regime_move',
    'regime_trend_stay',
    'regime_trend_enter',
    'regime_pullback',
    'regime_reversal',
    'regime_move_range',
    'regime_compress_abs',
    'regime_expand_abs',
  ] as const) {
    if (p[k] != null) {
      const n = Number(p[k]);
      if (Number.isFinite(n) && n > 0 && n < 0.05) {
        p[k] = roundRegimeBp(n * 10_000);
      }
    }
  }
}

function enforceRegimeLadder(g: BrainGenome): void {
  if (!(g.regime_compress_abs < g.regime_move)) {
    g.regime_compress_abs = roundRegimeBp(Math.min(g.regime_compress_abs, g.regime_move - 0.1));
  }
  if (g.regime_trend_stay < g.regime_move + g.gap_move_stay) {
    g.regime_trend_stay = bumpAbove(g.regime_move, g.gap_move_stay);
  }
  if (g.regime_trend_enter < g.regime_trend_stay + g.gap_stay_enter) {
    g.regime_trend_enter = bumpAbove(g.regime_trend_stay, g.gap_stay_enter);
  }
  if (g.regime_pullback < g.regime_trend_enter + g.gap_enter_pullback) {
    g.regime_pullback = bumpAbove(g.regime_trend_enter, g.gap_enter_pullback);
  }
  if (g.regime_reversal < g.regime_pullback + g.gap_pullback_reversal) {
    g.regime_reversal = bumpAbove(g.regime_pullback, g.gap_pullback_reversal);
  }
  if (!(g.regime_move <= g.regime_move_range)) {
    g.regime_move_range = g.regime_move;
  }
  if (!(g.regime_move_range <= g.regime_trend_stay)) {
    g.regime_move_range = g.regime_trend_stay;
  }
  if (g.regime_expand_abs <= g.regime_trend_enter) {
    g.regime_expand_abs = bumpAbove(g.regime_trend_enter, g.gap_stay_enter);
  }
  if (g.regime_expand_abs - g.regime_compress_abs < g.gap_compress_expand) {
    g.regime_expand_abs = roundRegimeBp(g.regime_compress_abs + g.gap_compress_expand);
  }
  if (!(g.regime_persist_stay <= g.regime_persist_enter)) {
    g.regime_persist_stay = Math.min(g.regime_persist_stay, g.regime_persist_enter);
  }
  if (!(g.regime_persist_pullback <= g.regime_persist_enter)) {
    g.regime_persist_pullback = Math.min(g.regime_persist_pullback, g.regime_persist_enter);
  }
  if (g.regime_persist_enter - g.regime_persist_stay < g.persist_enter_stay_min_gap - 1e-12) {
    g.regime_persist_stay = round2(
      Math.max(0.1, g.regime_persist_enter - g.persist_enter_stay_min_gap)
    );
  }
}

export function sanitizeGenome(raw: Partial<BrainGenome> | null | undefined): BrainGenome {
  const p0 = { ...(raw || {}) } as Record<string, unknown>;
  migrateLegacyKeys(p0);
  const p = p0 as Partial<BrainGenome>;
  const d = DEFAULT_GENOME;

  const g: BrainGenome = {
    version: Math.max(1, Math.floor(Number(p.version) || 1)),
    updated_at: String(p.updated_at || new Date().toISOString()),
    peak_keep: round2(clamp(Number(p.peak_keep ?? d.peak_keep), 0.65, 0.88)),
    peak_arm_soft_mult: round2(
      clamp(Number(p.peak_arm_soft_mult ?? d.peak_arm_soft_mult), 0.5, 1.2)
    ),
    soft_plus_giveback: round2(
      clamp(Number(p.soft_plus_giveback ?? d.soft_plus_giveback), 0.55, 0.85)
    ),
    require_1m_trigger: p.require_1m_trigger !== false,
    soft_same_side_pause_closes: clampInt(
      p.soft_same_side_pause_closes,
      d.soft_same_side_pause_closes,
      1,
      12
    ),
    soft_same_side_pause_min: clampInt(p.soft_same_side_pause_min, d.soft_same_side_pause_min, 1, 6),
    wait_on_1m_fight: p.wait_on_1m_fight !== false,
    mind_bank_on_turn: p.mind_bank_on_turn !== false,
    explore_step: clampInt(p.explore_step, d.explore_step, 0, 1_000_000_000),
    last_lesson: String(p.last_lesson || d.last_lesson).slice(0, 240),
    regime_move: clamp(coerceRegimeBp(p.regime_move, d.regime_move), 0.4, 2.0),
    regime_trend_stay: clamp(coerceRegimeBp(p.regime_trend_stay, d.regime_trend_stay), 1.0, 5.0),
    regime_trend_enter: clamp(coerceRegimeBp(p.regime_trend_enter, d.regime_trend_enter), 2.0, 8.0),
    regime_pullback: clamp(coerceRegimeBp(p.regime_pullback, d.regime_pullback), 3.0, 12.0),
    regime_reversal: clamp(coerceRegimeBp(p.regime_reversal, d.regime_reversal), 8.0, 40.0),
    regime_move_range: clamp(coerceRegimeBp(p.regime_move_range, d.regime_move_range), 0.6, 4.0),
    regime_compress_abs: clamp(coerceRegimeBp(p.regime_compress_abs, d.regime_compress_abs), 0.2, 1.2),
    regime_expand_abs: clamp(coerceRegimeBp(p.regime_expand_abs, d.regime_expand_abs), 3.0, 20.0),
    regime_compress_avg_mult: round2(
      clamp(Number(p.regime_compress_avg_mult ?? d.regime_compress_avg_mult), 0.15, 0.7)
    ),
    regime_expand_avg_mult: round2(
      clamp(Number(p.regime_expand_avg_mult ?? d.regime_expand_avg_mult), 1.2, 2.5)
    ),
    regime_near_zone_mid: round2(
      clamp(Number(p.regime_near_zone_mid ?? d.regime_near_zone_mid), 0.12, 0.45)
    ),
    regime_clear_break_frac: round2(
      clamp(Number(p.regime_clear_break_frac ?? d.regime_clear_break_frac), 0.1, 0.5)
    ),
    regime_persist_enter: round2(
      clamp(Number(p.regime_persist_enter ?? d.regime_persist_enter), 0.25, 0.85)
    ),
    regime_persist_stay: round2(
      clamp(Number(p.regime_persist_stay ?? d.regime_persist_stay), 0.1, 0.7)
    ),
    regime_persist_pullback: round2(
      clamp(Number(p.regime_persist_pullback ?? d.regime_persist_pullback), 0.1, 0.6)
    ),
    regime_range_chop_persist_max: round2(
      clamp(Number(p.regime_range_chop_persist_max ?? d.regime_range_chop_persist_max), 0.1, 0.55)
    ),
    regime_range_trek_share_max: round2(
      clamp(Number(p.regime_range_trek_share_max ?? d.regime_range_trek_share_max), 0.12, 0.55)
    ),
    regime_range_trek_eff_max: round2(
      clamp(Number(p.regime_range_trek_eff_max ?? d.regime_range_trek_eff_max), 0.15, 0.7)
    ),
    regime_min_dwell_bars: clampInt(p.regime_min_dwell_bars, d.regime_min_dwell_bars, 2, 12),
    regime_confirm_bars: clampInt(p.regime_confirm_bars, d.regime_confirm_bars, 1, 8),
    regime_mom_bars: clampInt(p.regime_mom_bars, d.regime_mom_bars, 4, 16),
    regime_persist_window: clampInt(p.regime_persist_window, d.regime_persist_window, 3, 12),
    mtf_trek_flat_frac: clamp(coerceRegimeBp(p.mtf_trek_flat_frac, d.mtf_trek_flat_frac), 1.5, 12.0),
    hardinv_pct_bp: clamp(
      coerceMicroBp(p.hardinv_pct_bp, d.hardinv_pct_bp),
      HARDINV_PCT_BP_MIN,
      200
    ),
    peak_mfe_pct_bp: clamp(coerceMicroBp(p.peak_mfe_pct_bp, d.peak_mfe_pct_bp), 0.1, 200),
    target_pct_bp: clamp(coerceMicroBp(p.target_pct_bp, d.target_pct_bp), 0.1, 500),
    story_min_path_bp: clamp(coerceMicroBp(p.story_min_path_bp, d.story_min_path_bp), 0.1, 50),
    gap_move_stay: round1(clamp(Number(p.gap_move_stay ?? d.gap_move_stay), 0.1, 5)),
    gap_stay_enter: round1(clamp(Number(p.gap_stay_enter ?? d.gap_stay_enter), 0.1, 5)),
    gap_enter_pullback: round1(clamp(Number(p.gap_enter_pullback ?? d.gap_enter_pullback), 0.1, 5)),
    gap_pullback_reversal: round1(
      clamp(Number(p.gap_pullback_reversal ?? d.gap_pullback_reversal), 0.5, 20)
    ),
    gap_compress_expand: round1(clamp(Number(p.gap_compress_expand ?? d.gap_compress_expand), 0.5, 20)),
    persist_enter_stay_min_gap: round2(
      clamp(Number(p.persist_enter_stay_min_gap ?? d.persist_enter_stay_min_gap), 0.05, 0.4)
    ),
  };

  enforceRegimeLadder(g);
  return g;
}

let cache: BrainGenome | null = null;
let cacheMtimeMs = Number.NaN;

export function getBrainGenome(): BrainGenome {
  const p = genomePath();
  try {
    if (fs.existsSync(p)) {
      const mtimeMs = fs.statSync(p).mtimeMs;
      if (cache && Number.isFinite(cacheMtimeMs) && mtimeMs === cacheMtimeMs) {
        return cache;
      }
      const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<BrainGenome>;
      cache = sanitizeGenome(raw);
      cacheMtimeMs = mtimeMs;
      return cache;
    }
  } catch {
    /* factory */
  }
  if (cache) return cache;
  cache = { ...DEFAULT_GENOME, updated_at: new Date().toISOString() };
  cacheMtimeMs = Number.NaN;
  return cache;
}

export function setBrainGenome(next: Partial<BrainGenome>): BrainGenome {
  const merged = sanitizeGenome({
    ...getBrainGenome(),
    ...next,
    updated_at: new Date().toISOString(),
  });
  const p = genomePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  cache = merged;
  try {
    cacheMtimeMs = fs.statSync(p).mtimeMs;
  } catch {
    cacheMtimeMs = Number.NaN;
  }
  return merged;
}

export function reloadBrainGenome(): BrainGenome {
  cache = null;
  cacheMtimeMs = Number.NaN;
  return getBrainGenome();
}

export function defaultBrainGenome(): BrainGenome {
  return { ...DEFAULT_GENOME };
}

/** Test helper */
export function _resetBrainGenomeForTests(g?: Partial<BrainGenome>): void {
  cache = sanitizeGenome({ ...DEFAULT_GENOME, ...g, updated_at: new Date().toISOString() });
  cacheMtimeMs = Number.NaN;
}
