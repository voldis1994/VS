/**
 * Runtime genome — thresholds the trading brain can evolve without touching lot/broker.
 * Decision code reads these via getBrainGenome(); self-improve mutates genome.json candidates.
 *
 * Trading-intelligence knobs (regime ladder, dwell/confirm, multi-TF stringency) live here
 * so Brain Self Improve can evolve market perception — not only Peak/Soft memory.
 * Missing fields from older genome.json fall back to factory (= prior hardcoded values).
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

  // ——— Regime body / range ladder (factory = prior regimeBands.ts constants) ———
  /** Shared 10s move floor — persist vote / failed-breakout tick */
  regime_move: number;
  /** Stay in an existing trend (must be > regime_move) */
  regime_trend_stay: number;
  /** Enter a fresh trend (must be > regime_trend_stay) */
  regime_trend_enter: number;
  /** Against-trend pullback body (must be > regime_trend_enter) */
  regime_pullback: number;
  /** Violent reversal body (must be > regime_pullback) */
  regime_reversal: number;
  /** isMoving range floor */
  regime_move_range: number;
  /** Compression absolute range (must be < regime_move) */
  regime_compress_abs: number;
  /** Expansion absolute range (must be > regime_trend_enter) */
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
  /** Soft regime switch dwell (10s bars) */
  regime_min_dwell_bars: number;
  /** Cross-family confirm bars after dwell */
  regime_confirm_bars: number;
  /** Momentum window length (10s bars) — factory 8 */
  regime_mom_bars: number;
  /** Persistence mean window inside mom (factory 6) */
  regime_persist_window: number;

  // ——— Multi-TF / entry interpretation stringency ———
  /** Trek flat if range < mid * this (Capital candle trek) */
  mtf_trek_flat_frac: number;
  /** When true, 30m vs 15m fight clears working bias (WAIT) */
  mtf_block_higher_fight: boolean;
  /** When true, sideFromMultiTf requires stack.aligned */
  mtf_require_aligned_side: boolean;
  /** When true, mind vetoes SELL vs UP 30/15 and BUY vs DOWN 30/15 */
  mtf_htf_veto: boolean;
  /** Flat-stack story allow needs story_conf ≥ this */
  entry_story_conf_min: number;
  /** Chop / weak story WAIT when story_conf < this */
  entry_chop_conf_max: number;
};

/** Factory = prior hardcoded behaviour (regimeBands + multi-TF + mind gates). */
const DEFAULT_GENOME: BrainGenome = {
  version: 1,
  updated_at: new Date(0).toISOString(),
  peak_keep: 0.75,
  peak_arm_soft_mult: 1.0,
  soft_plus_giveback: 0.75,
  require_1m_trigger: true,
  soft_same_side_pause_closes: 4,
  soft_same_side_pause_min: 2,
  wait_on_1m_fight: true,
  mind_bank_on_turn: true,
  explore_step: 0,
  last_lesson: 'factory genome',

  regime_move: 0.00008,
  regime_trend_stay: 0.00022,
  regime_trend_enter: 0.00038,
  regime_pullback: 0.00055,
  regime_reversal: 0.0016,
  regime_move_range: 0.00012,
  regime_compress_abs: 0.000055,
  regime_expand_abs: 0.0006,
  regime_compress_avg_mult: 0.35,
  regime_expand_avg_mult: 1.65,
  regime_near_zone_mid: 0.28,
  regime_clear_break_frac: 0.25,
  regime_persist_enter: 0.5,
  regime_persist_stay: 0.3,
  regime_persist_pullback: 0.2,
  regime_min_dwell_bars: 5,
  regime_confirm_bars: 3,
  regime_mom_bars: 8,
  regime_persist_window: 6,

  mtf_trek_flat_frac: 0.0004,
  mtf_block_higher_fight: true,
  mtf_require_aligned_side: true,
  mtf_htf_veto: true,
  entry_story_conf_min: 0.55,
  entry_chop_conf_max: 0.45,
};

function repoRoot(): string {
  // apps/control-api/src/brainSelfImprove → repo root
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

/** Tiny positive step used when repairing ladder order after a wild mutation. */
function bumpAbove(floor: number, gap: number): number {
  return floor + gap;
}

/**
 * Keep body/range ladder coherent after independent clamps.
 * Does not change meaning of regimes — only prevents contradictory thresholds.
 */
function enforceRegimeLadder(g: BrainGenome): void {
  const bodyGap = 0.00005;
  if (!(g.regime_compress_abs < g.regime_move)) {
    g.regime_compress_abs = Math.min(g.regime_compress_abs, g.regime_move - 1e-7);
  }
  if (!(g.regime_move < g.regime_trend_stay)) {
    g.regime_trend_stay = bumpAbove(g.regime_move, bodyGap);
  }
  if (!(g.regime_trend_stay < g.regime_trend_enter)) {
    g.regime_trend_enter = bumpAbove(g.regime_trend_stay, bodyGap);
  }
  if (!(g.regime_trend_enter < g.regime_pullback)) {
    g.regime_pullback = bumpAbove(g.regime_trend_enter, bodyGap);
  }
  if (!(g.regime_pullback < g.regime_reversal)) {
    g.regime_reversal = bumpAbove(g.regime_pullback, bodyGap * 2);
  }
  if (!(g.regime_move <= g.regime_move_range)) {
    g.regime_move_range = g.regime_move;
  }
  if (!(g.regime_move_range <= g.regime_trend_stay)) {
    g.regime_move_range = g.regime_trend_stay;
  }
  if (!(g.regime_expand_abs > g.regime_trend_enter)) {
    g.regime_expand_abs = bumpAbove(g.regime_trend_enter, bodyGap);
  }
  if (!(g.regime_persist_stay <= g.regime_persist_enter)) {
    g.regime_persist_stay = Math.min(g.regime_persist_stay, g.regime_persist_enter);
  }
  if (!(g.regime_persist_pullback <= g.regime_persist_enter)) {
    g.regime_persist_pullback = Math.min(g.regime_persist_pullback, g.regime_persist_enter);
  }
}

export function sanitizeGenome(raw: Partial<BrainGenome> | null | undefined): BrainGenome {
  const p = raw || {};
  const g: BrainGenome = {
    version: Math.max(1, Math.floor(Number(p.version) || 1)),
    updated_at: String(p.updated_at || new Date().toISOString()),
    peak_keep: Math.round(clamp(Number(p.peak_keep ?? DEFAULT_GENOME.peak_keep), 0.1, 0.95) * 100) / 100,
    peak_arm_soft_mult:
      Math.round(
        clamp(Number(p.peak_arm_soft_mult ?? DEFAULT_GENOME.peak_arm_soft_mult), 0.5, 1.2) * 100
      ) / 100,
    soft_plus_giveback:
      Math.round(
        clamp(Number(p.soft_plus_giveback ?? DEFAULT_GENOME.soft_plus_giveback), 0.55, 0.85) * 100
      ) / 100,
    require_1m_trigger: p.require_1m_trigger !== false,
    soft_same_side_pause_closes: Math.max(
      1,
      Math.min(12, Math.floor(Number(p.soft_same_side_pause_closes) || 4))
    ),
    soft_same_side_pause_min: Math.max(
      1,
      Math.min(6, Math.floor(Number(p.soft_same_side_pause_min) || 2))
    ),
    wait_on_1m_fight: p.wait_on_1m_fight !== false,
    mind_bank_on_turn: p.mind_bank_on_turn !== false,
    explore_step: Math.max(0, Math.floor(Number(p.explore_step) || 0)),
    last_lesson: String(p.last_lesson || DEFAULT_GENOME.last_lesson).slice(0, 240),

    regime_move: clamp(Number(p.regime_move ?? DEFAULT_GENOME.regime_move), 0.00004, 0.0002),
    regime_trend_stay: clamp(
      Number(p.regime_trend_stay ?? DEFAULT_GENOME.regime_trend_stay),
      0.0001,
      0.0005
    ),
    regime_trend_enter: clamp(
      Number(p.regime_trend_enter ?? DEFAULT_GENOME.regime_trend_enter),
      0.0002,
      0.0008
    ),
    regime_pullback: clamp(
      Number(p.regime_pullback ?? DEFAULT_GENOME.regime_pullback),
      0.0003,
      0.0012
    ),
    regime_reversal: clamp(
      Number(p.regime_reversal ?? DEFAULT_GENOME.regime_reversal),
      0.0008,
      0.004
    ),
    regime_move_range: clamp(
      Number(p.regime_move_range ?? DEFAULT_GENOME.regime_move_range),
      0.00006,
      0.0004
    ),
    regime_compress_abs: clamp(
      Number(p.regime_compress_abs ?? DEFAULT_GENOME.regime_compress_abs),
      0.00002,
      0.00012
    ),
    regime_expand_abs: clamp(
      Number(p.regime_expand_abs ?? DEFAULT_GENOME.regime_expand_abs),
      0.0003,
      0.002
    ),
    regime_compress_avg_mult: clamp(
      Number(p.regime_compress_avg_mult ?? DEFAULT_GENOME.regime_compress_avg_mult),
      0.15,
      0.7
    ),
    regime_expand_avg_mult: clamp(
      Number(p.regime_expand_avg_mult ?? DEFAULT_GENOME.regime_expand_avg_mult),
      1.2,
      2.5
    ),
    regime_near_zone_mid: clamp(
      Number(p.regime_near_zone_mid ?? DEFAULT_GENOME.regime_near_zone_mid),
      0.12,
      0.45
    ),
    regime_clear_break_frac: clamp(
      Number(p.regime_clear_break_frac ?? DEFAULT_GENOME.regime_clear_break_frac),
      0.1,
      0.5
    ),
    regime_persist_enter: clamp(
      Number(p.regime_persist_enter ?? DEFAULT_GENOME.regime_persist_enter),
      0.25,
      0.85
    ),
    regime_persist_stay: clamp(
      Number(p.regime_persist_stay ?? DEFAULT_GENOME.regime_persist_stay),
      0.1,
      0.7
    ),
    regime_persist_pullback: clamp(
      Number(p.regime_persist_pullback ?? DEFAULT_GENOME.regime_persist_pullback),
      0.05,
      0.6
    ),
    regime_min_dwell_bars: Math.max(
      2,
      Math.min(12, Math.floor(Number(p.regime_min_dwell_bars) || DEFAULT_GENOME.regime_min_dwell_bars))
    ),
    regime_confirm_bars: Math.max(
      1,
      Math.min(8, Math.floor(Number(p.regime_confirm_bars) || DEFAULT_GENOME.regime_confirm_bars))
    ),
    regime_mom_bars: Math.max(
      4,
      Math.min(16, Math.floor(Number(p.regime_mom_bars) || DEFAULT_GENOME.regime_mom_bars))
    ),
    regime_persist_window: Math.max(
      3,
      Math.min(12, Math.floor(Number(p.regime_persist_window) || DEFAULT_GENOME.regime_persist_window))
    ),

    mtf_trek_flat_frac:
      Math.round(
        clamp(Number(p.mtf_trek_flat_frac ?? DEFAULT_GENOME.mtf_trek_flat_frac), 0.00015, 0.0012) *
          1e5
      ) / 1e5,
    mtf_block_higher_fight: p.mtf_block_higher_fight !== false,
    mtf_require_aligned_side: p.mtf_require_aligned_side !== false,
    mtf_htf_veto: p.mtf_htf_veto !== false,
    entry_story_conf_min:
      Math.round(
        clamp(Number(p.entry_story_conf_min ?? DEFAULT_GENOME.entry_story_conf_min), 0.35, 0.8) * 100
      ) / 100,
    entry_chop_conf_max:
      Math.round(
        clamp(Number(p.entry_chop_conf_max ?? DEFAULT_GENOME.entry_chop_conf_max), 0.25, 0.65) * 100
      ) / 100,
  };

  if (!(g.entry_chop_conf_max < g.entry_story_conf_min)) {
    g.entry_chop_conf_max = Math.min(g.entry_chop_conf_max, g.entry_story_conf_min - 0.01);
  }

  enforceRegimeLadder(g);
  if (g.regime_persist_window > g.regime_mom_bars) {
    g.regime_persist_window = g.regime_mom_bars;
  }
  return g;
}

let cache: BrainGenome | null = null;
/** Disk mtime of last successful genome load — BRAIN process writes, API hot-reloads. */
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
  const merged = sanitizeGenome({ ...getBrainGenome(), ...next, updated_at: new Date().toISOString() });
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

/** Keys Brain Self Improve may safely evolve (not lot/broker/HardInv). */
export const EVOLVABLE_GENOME_KEYS: ReadonlyArray<keyof BrainGenome> = [
  'peak_keep',
  'peak_arm_soft_mult',
  'soft_plus_giveback',
  'require_1m_trigger',
  'soft_same_side_pause_closes',
  'soft_same_side_pause_min',
  'wait_on_1m_fight',
  'mind_bank_on_turn',
  'explore_step',
  'version',
  'last_lesson',
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
  'regime_min_dwell_bars',
  'regime_confirm_bars',
  'regime_mom_bars',
  'regime_persist_window',
  'mtf_trek_flat_frac',
  'mtf_block_higher_fight',
  'mtf_require_aligned_side',
  'mtf_htf_veto',
  'entry_story_conf_min',
  'entry_chop_conf_max',
];

/**
 * Trading-intelligence keys that require measurable eval improvement to ACCEPT.
 * Only keys that reach the live decideEntryWithStructure → thinkEntryLikeTrader
 * path and have a discriminative probe. Dead / thesis-only knobs stay on the
 * genome but are not evolved as trading-intel (mtf_htf_veto unreachable once
 * multiTfRead sets stackSide; entry_chop_conf_max only swaps WAIT thesis).
 */
export const TRADING_INTEL_GENOME_KEYS: ReadonlyArray<keyof BrainGenome> = [
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
  'regime_min_dwell_bars',
  'regime_confirm_bars',
  'regime_mom_bars',
  'regime_persist_window',
  'mtf_trek_flat_frac',
  'mtf_block_higher_fight',
  'mtf_require_aligned_side',
  'entry_story_conf_min',
];

/** Peak / Soft memory keys that may ACCEPT on E-flat defensive path. */
export const PEAK_MEMORY_SAFE_KEYS: ReadonlyArray<keyof BrainGenome> = [
  'peak_keep',
  'peak_arm_soft_mult',
  'soft_plus_giveback',
  'require_1m_trigger',
  'soft_same_side_pause_closes',
  'soft_same_side_pause_min',
  'wait_on_1m_fight',
  'mind_bank_on_turn',
  'explore_step',
  'version',
  'last_lesson',
];

/** Test helper — updates cache and disk when BRAIN_GENOME_PATH is set. */
export function _resetBrainGenomeForTests(g?: Partial<BrainGenome>): void {
  cache = sanitizeGenome({ ...DEFAULT_GENOME, ...g, updated_at: new Date().toISOString() });
  cacheMtimeMs = Number.NaN;
  const p = process.env.BRAIN_GENOME_PATH?.trim();
  if (p) {
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(cache, null, 2) + '\n', 'utf8');
      cacheMtimeMs = fs.statSync(p).mtimeMs;
    } catch {
      cacheMtimeMs = Number.NaN;
    }
  }
}
