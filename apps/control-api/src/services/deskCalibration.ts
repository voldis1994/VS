/** Desk calibration — HardInv / Peak / Target + which regimes may enter. */
import fs from 'node:fs';
import path from 'node:path';
import { REGIME_NAMES, type RegimeName } from './regimes.js';

export type DeskCalibration = {
  /** Soft HardInv absolute CAP (price points) — not a floor */
  hardinv_abs: number;
  /** PeakProtect arms / cuts only after this MFE (pts) — must be > hardinv */
  peak_mfe_abs: number;
  /** Keep this fraction of MFE (0.65 ≈ 35% giveback) */
  peak_retention: number;
  /** Min absolute giveback before Peak cuts (pts) */
  peak_min_giveback_abs: number;
  /** Soft Target absolute floor (pts) — should be > hardinv */
  target_abs: number;
  /** Soft HardInv as fraction of price (capped by hardinv_abs) */
  hardinv_pct: number;
  /** Target as fraction of price */
  target_pct: number;
  /** Peak MFE floor as fraction of price */
  peak_mfe_pct: number;
  /**
   * Regimes allowed to open new entries.
   * Empty → none (operator must pick). UNKNOWN never trades.
   */
  enabled_regimes: RegimeName[];
  updated_at: string;
};

/** Wait-only regimes never enter — keep them out of the default allowlist (UI trap). */
const WAIT_ONLY_REGIMES = new Set<RegimeName>(['COMPRESSION', 'TRANSITION', 'UNKNOWN']);

const TRADABLE_DEFAULT: RegimeName[] = REGIME_NAMES.filter(
  (r) => !WAIT_ONLY_REGIMES.has(r)
) as RegimeName[];

export function defaultDeskCalibration(): DeskCalibration {
  return {
    // Let winners run vs Soft — Funds showed +£0.01…£0.05 Peak vs −£0.10…£0.21 Soft.
    // Soft CAP ~2.0; Peak only after ≥4.5pt MFE; retain 75%; Target ~7.
    hardinv_abs: 2.0,
    peak_mfe_abs: 4.5,
    peak_retention: 0.75,
    peak_min_giveback_abs: 1.2,
    target_abs: 7.0,
    hardinv_pct: 0.0007,
    target_pct: 0.0032,
    peak_mfe_pct: 0.0014,
    enabled_regimes: [...TRADABLE_DEFAULT],
    updated_at: new Date().toISOString(),
  };
}

function calibrationPath(): string {
  const env = process.env.DESK_CALIBRATION_PATH?.trim();
  if (env) return env;
  return path.join(process.cwd(), 'data', 'desk-calibration.json');
}

let cached: DeskCalibration | null = null;

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function sanitize(partial: Partial<DeskCalibration> | null | undefined): DeskCalibration {
  const base = defaultDeskCalibration();
  const p = partial || {};
  const regimesRaw = Array.isArray(p.enabled_regimes) ? p.enabled_regimes : base.enabled_regimes;
  const enabled = [
    ...new Set(
      regimesRaw
        .map((r) => String(r || '').trim().toUpperCase())
        .filter(
        (r): r is RegimeName =>
          (REGIME_NAMES as readonly string[]).includes(r) && !WAIT_ONLY_REGIMES.has(r as RegimeName)
      )
    ),
  ] as RegimeName[];

  return {
    hardinv_abs: clamp(Number(p.hardinv_abs ?? base.hardinv_abs), 0.2, 50),
    peak_mfe_abs: clamp(Number(p.peak_mfe_abs ?? base.peak_mfe_abs), 0.2, 50),
    peak_retention: clamp(Number(p.peak_retention ?? base.peak_retention), 0.5, 0.95),
    peak_min_giveback_abs: clamp(
      Number(p.peak_min_giveback_abs ?? base.peak_min_giveback_abs),
      0.1,
      20
    ),
    target_abs: clamp(Number(p.target_abs ?? base.target_abs), 0.5, 100),
    hardinv_pct: clamp(Number(p.hardinv_pct ?? base.hardinv_pct), 0.0001, 0.02),
    target_pct: clamp(Number(p.target_pct ?? base.target_pct), 0.0002, 0.05),
    peak_mfe_pct: clamp(Number(p.peak_mfe_pct ?? base.peak_mfe_pct), 0.00005, 0.02),
    enabled_regimes: enabled,
    updated_at: new Date().toISOString(),
  };
}

function loadFromDisk(): DeskCalibration {
  try {
    const file = calibrationPath();
    if (!fs.existsSync(file)) return defaultDeskCalibration();
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DeskCalibration>;
    // One-shot upgrades (regimes kept):
    // 1) old scalp: Peak <2 + wide HardInv %
    // 2) micro-Peak: Peak <4 / Target <6.5 (Funds +£0.01…£0.05 vs Soft −£0.21)
    const peakAbs = Number(raw.peak_mfe_abs);
    const hiPct = Number(raw.hardinv_pct);
    const targetAbs = Number(raw.target_abs);
    const scalpLegacy =
      Number.isFinite(peakAbs) &&
      peakAbs > 0 &&
      peakAbs < 2.0 &&
      Number.isFinite(hiPct) &&
      hiPct >= 0.0012;
    const microPeak =
      Number.isFinite(peakAbs) &&
      peakAbs > 0 &&
      peakAbs < 4.0 &&
      Number.isFinite(targetAbs) &&
      targetAbs < 6.5;
    if (scalpLegacy || microPeak) {
      return sanitize({
        ...defaultDeskCalibration(),
        enabled_regimes: raw.enabled_regimes,
      });
    }
    return sanitize(raw);
  } catch {
    return defaultDeskCalibration();
  }
}

function saveToDisk(cfg: DeskCalibration): void {
  const file = calibrationPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8');
}

export function getDeskCalibration(): DeskCalibration {
  if (!cached) cached = loadFromDisk();
  return cached;
}

export function setDeskCalibration(partial: Partial<DeskCalibration>): DeskCalibration {
  const next = sanitize({ ...getDeskCalibration(), ...partial });
  cached = next;
  saveToDisk(next);
  return next;
}

/** True when this regime is allowed to open a new entry. */
export function regimeAllowedForEntry(regime?: string | null): boolean {
  const r = String(regime || '')
    .trim()
    .toUpperCase();
  if (!r || r === 'UNKNOWN') return false;
  const cfg = getDeskCalibration();
  if (!cfg.enabled_regimes.length) return false;
  return cfg.enabled_regimes.includes(r as RegimeName);
}

export function deskCalibrationCatalog() {
  return {
    regimes: [...REGIME_NAMES],
    wait_only: ['COMPRESSION', 'TRANSITION', 'UNKNOWN'],
    tradable_default: [...TRADABLE_DEFAULT],
    knobs: [
      'hardinv_abs',
      'hardinv_pct',
      'peak_mfe_abs',
      'peak_mfe_pct',
      'peak_retention',
      'peak_min_giveback_abs',
      'target_abs',
      'target_pct',
      'enabled_regimes',
    ],
  };
}
