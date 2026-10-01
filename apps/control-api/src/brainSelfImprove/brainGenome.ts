/**
 * Runtime genome — thresholds the trading brain can evolve without touching lot/broker.
 * Decision code reads these via getBrainGenome(); self-improve mutates genome.json candidates.
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
};

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

export function sanitizeGenome(raw: Partial<BrainGenome> | null | undefined): BrainGenome {
  const p = raw || {};
  return {
    version: Math.max(1, Math.floor(Number(p.version) || 1)),
    updated_at: String(p.updated_at || new Date().toISOString()),
    peak_keep: clamp(Number(p.peak_keep ?? DEFAULT_GENOME.peak_keep), 0.65, 0.88),
    peak_arm_soft_mult: clamp(
      Number(p.peak_arm_soft_mult ?? DEFAULT_GENOME.peak_arm_soft_mult),
      0.5,
      1.2
    ),
    soft_plus_giveback: clamp(
      Number(p.soft_plus_giveback ?? DEFAULT_GENOME.soft_plus_giveback),
      0.55,
      0.85
    ),
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
  };
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

/** Test helper */
export function _resetBrainGenomeForTests(g?: Partial<BrainGenome>): void {
  cache = sanitizeGenome({ ...DEFAULT_GENOME, ...g, updated_at: new Date().toISOString() });
  cacheMtimeMs = Number.NaN;
}
