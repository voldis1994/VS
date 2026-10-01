/** Desk calibration — HardInv / Peak / Target + which regimes may enter. */
import fs from 'node:fs';
import path from 'node:path';
import {
  deskKnobsFromGenome,
  setBrainGenome,
} from '../brainSelfImprove/brainGenome.js';
import { REGIME_NAMES, type RegimeName } from './regimes.js';
import { resolveDeskClientId } from './deskClientScope.js';

export type DeskCalibration = {
  /** Soft HardInv absolute CAP (price points) — not a floor · alias Soft L3 */
  hardinv_abs: number;
  /** Soft HardInv L1 (tightest) — no MFE → this room */
  soft_l1_abs: number;
  /** Soft HardInv L2 — unlocked after Soft L1-sized MFE */
  soft_l2_abs: number;
  /** Soft HardInv L3 (= hardinv_abs) — unlocked after Soft L2-sized MFE */
  soft_l3_abs: number;
  /** PeakProtect arms / cuts only after this MFE (pts) — must be > hardinv */
  peak_mfe_abs: number;
  /** Keep this fraction of MFE (0.65 ≈ 35% giveback) */
  peak_retention: number;
  /** Min absolute giveback before Peak cuts (pts) */
  peak_min_giveback_abs: number;
  /** Soft Target absolute floor (pts) — alias Target L3 */
  target_abs: number;
  /** Target L1 — scalp bank when leg never stretched to L2 */
  target_l1_abs: number;
  /** Target L2 — mid bank when leg never stretched to L3 */
  target_l2_abs: number;
  /** Target L3 (= target_abs) — full runner */
  target_l3_abs: number;
  /**
   * Broker SAFETY TP as multiple of SAFETY SL distance.
   * This is what Capital profitLevel uses — Soft Target alone does not move
   * broker TP when SL cushion (≈0.2%) dominates. Auto-cal tunes THIS.
   */
  safety_tp_rr: number;
  /** Soft HardInv as fraction of price (capped by hardinv_abs) */
  hardinv_pct: number;
  /** Target as fraction of price */
  target_pct: number;
  /** Peak MFE floor as fraction of price */
  peak_mfe_pct: number;
  /**
   * Soft entry filter ladder (auto-cal owned).
   * 0=OPEN … 3=STRICT. Start at 0; auto-cal raises after bad closes.
   */
  entry_filter_level: number;
  /**
   * Regimes allowed to open new entries.
   * Empty → none (operator must pick). UNKNOWN never trades.
   */
  enabled_regimes: RegimeName[];
  /**
   * Soft OFF — auto-cal demoted after Soft knife/chop.
   * Weak signals blocked; strong playbook+story+HTF may still enter.
   * Hard OFF = not in enabled and not here (operator kill / UNKNOWN).
   */
  soft_off_regimes: RegimeName[];
  updated_at: string;
};

/** Only UNKNOWN stays out — no structure yet. Everything else starts ON; auto-cal demotes. */
const NEVER_ENTRY_REGIMES = new Set<RegimeName>(['UNKNOWN']);

const TRADABLE_DEFAULT: RegimeName[] = REGIME_NAMES.filter(
  (r) => !NEVER_ENTRY_REGIMES.has(r)
) as RegimeName[];

export function tradableDefaultRegimes(): RegimeName[] {
  return [...TRADABLE_DEFAULT];
}

export function defaultDeskCalibration(): DeskCalibration {
  return {
    // Positive R:R — Soft HardInv CAP ~2.2; Peak only after real ≥3pt leg; Target ≥4–5
    // (old scalp profile banked +0.5 Peak vs −4 Soft HardInv → 80% wins, net minus)
    // Soft/Target 3-layer ladder — L3 aliases hardinv_abs / target_abs
    hardinv_abs: 2.2,
    soft_l1_abs: 1.2,
    soft_l2_abs: 1.8,
    soft_l3_abs: 2.2,
    peak_mfe_abs: 3.0,
    peak_retention: 0.75,
    peak_min_giveback_abs: 0.85,
    target_abs: 5.0,
    target_l1_abs: 2.5,
    target_l2_abs: 3.5,
    target_l3_abs: 5.0,
    safety_tp_rr: 1.5,
    hardinv_pct: 0.0008,
    target_pct: 0.0025,
    peak_mfe_pct: 0.0009,
    entry_filter_level: 0,
    enabled_regimes: [...TRADABLE_DEFAULT],
    soft_off_regimes: [],
    updated_at: new Date().toISOString(),
  };
}

function legacyCalibrationPath(): string {
  const env = process.env.DESK_CALIBRATION_PATH?.trim();
  if (env) return env;
  return path.join(process.cwd(), 'data', 'desk-calibration.json');
}

function calibrationPath(clientId: number): string {
  if (clientId > 0) {
    return path.join(process.cwd(), 'data', 'desk-calibration', `client-${clientId}.json`);
  }
  return legacyCalibrationPath();
}

/** Per-client cache (0 = legacy/global). */
const cacheByClient = new Map<number, DeskCalibration>();

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function sanitizeRegimes(raw: unknown): RegimeName[] {
  const list = Array.isArray(raw) ? raw : [];
  return [
    ...new Set(
      list
        .map((r) => String(r || '').trim().toUpperCase())
        .filter(
          (r): r is RegimeName =>
            (REGIME_NAMES as readonly string[]).includes(r) &&
            !NEVER_ENTRY_REGIMES.has(r as RegimeName)
        )
    ),
  ] as RegimeName[];
}

function sanitize(partial: Partial<DeskCalibration> | null | undefined): DeskCalibration {
  const base = defaultDeskCalibration();
  const p = partial || {};
  const enabled = sanitizeRegimes(
    Array.isArray(p.enabled_regimes) ? p.enabled_regimes : base.enabled_regimes
  );
  // Soft OFF cannot overlap ON — promoting clears Soft OFF
  const softOff = sanitizeRegimes(
    Array.isArray(p.soft_off_regimes) ? p.soft_off_regimes : base.soft_off_regimes
  ).filter((r) => !enabled.includes(r));

  // Soft/Target 3-layer ladder — L3 syncs hardinv_abs / target_abs
  const {
    soft_l1_abs,
    soft_l2_abs,
    soft_l3_abs,
    hardinv_abs,
    target_l1_abs,
    target_l2_abs,
    target_l3_abs,
    target_abs,
  } = coerceLayerFieldsInline(p, base);

  return {
    hardinv_abs,
    soft_l1_abs,
    soft_l2_abs,
    soft_l3_abs,
    peak_mfe_abs: Math.round(clamp(Number(p.peak_mfe_abs ?? base.peak_mfe_abs), 0.2, 50) * 10) / 10,
    peak_retention:
      Math.round(clamp(Number(p.peak_retention ?? base.peak_retention), 0.1, 0.95) * 100) / 100,
    peak_min_giveback_abs:
      Math.round(clamp(Number(p.peak_min_giveback_abs ?? base.peak_min_giveback_abs), 0.1, 20) * 10) /
      10,
    target_abs,
    target_l1_abs,
    target_l2_abs,
    target_l3_abs,
    safety_tp_rr:
      Math.round(clamp(Number(p.safety_tp_rr ?? base.safety_tp_rr), 1.5, 4.0) * 100) / 100,
    hardinv_pct:
      Math.round(clamp(Number(p.hardinv_pct ?? base.hardinv_pct), 0.0001, 0.02) * 1e4) / 1e4,
    target_pct:
      Math.round(clamp(Number(p.target_pct ?? base.target_pct), 0.0002, 0.05) * 1e5) / 1e5,
    peak_mfe_pct:
      Math.round(clamp(Number(p.peak_mfe_pct ?? base.peak_mfe_pct), 0.00005, 0.02) * 1e5) / 1e5,
    entry_filter_level: Math.round(
      clamp(Number(p.entry_filter_level ?? base.entry_filter_level), 0, 3)
    ),
    enabled_regimes: enabled,
    soft_off_regimes: softOff,
    updated_at: new Date().toISOString(),
  };
}

/** Inline coerce — keep deskCalibration free of circular imports with profitLayers. */
function coerceLayerFieldsInline(
  p: Partial<DeskCalibration>,
  base: DeskCalibration
): {
  soft_l1_abs: number;
  soft_l2_abs: number;
  soft_l3_abs: number;
  hardinv_abs: number;
  target_l1_abs: number;
  target_l2_abs: number;
  target_l3_abs: number;
  target_abs: number;
} {
  const sort3 = (a: number, b: number, c: number): [number, number, number] => {
    const xs = [a, b, c].sort((x, y) => x - y);
    return [xs[0]!, xs[1]!, xs[2]!];
  };
  const s3 = Math.round(clamp(Number(p.hardinv_abs ?? p.soft_l3_abs ?? base.hardinv_abs), 0.2, 50) * 10) / 10;
  const s1 =
    Math.round(
      clamp(Number(p.soft_l1_abs ?? base.soft_l1_abs ?? s3 * 0.55), 0.2, 50) * 10
    ) / 10;
  const s2 =
    Math.round(
      clamp(Number(p.soft_l2_abs ?? base.soft_l2_abs ?? s3 * 0.8), 0.2, 50) * 10
    ) / 10;
  const soft = sort3(s1, s2, s3);
  const t3 =
    Math.round(clamp(Number(p.target_abs ?? p.target_l3_abs ?? base.target_abs), 0.5, 100) * 10) /
    10;
  const t1 =
    Math.round(
      clamp(Number(p.target_l1_abs ?? base.target_l1_abs ?? t3 * 0.5), 0.5, 100) * 10
    ) / 10;
  const t2 =
    Math.round(
      clamp(Number(p.target_l2_abs ?? base.target_l2_abs ?? t3 * 0.7), 0.5, 100) * 10
    ) / 10;
  const target = sort3(t1, t2, t3);
  return {
    soft_l1_abs: soft[0]!,
    soft_l2_abs: soft[1]!,
    soft_l3_abs: soft[2]!,
    hardinv_abs: soft[2]!,
    target_l1_abs: target[0]!,
    target_l2_abs: target[1]!,
    target_l3_abs: target[2]!,
    target_abs: target[2]!,
  };
}

function loadFromDisk(clientId: number): DeskCalibration {
  try {
    const file = calibrationPath(clientId);
    if (!fs.existsSync(file)) {
      // Seed new client from legacy global if present
      if (clientId > 0) {
        const legacy = legacyCalibrationPath();
        if (fs.existsSync(legacy)) {
          const raw = JSON.parse(fs.readFileSync(legacy, 'utf8')) as Partial<DeskCalibration>;
          return sanitize(raw);
        }
      }
      return defaultDeskCalibration();
    }
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DeskCalibration>;
    const peakAbs = Number(raw.peak_mfe_abs);
    const hiPct = Number(raw.hardinv_pct);
    if (
      Number.isFinite(peakAbs) &&
      peakAbs > 0 &&
      peakAbs < 2.0 &&
      Number.isFinite(hiPct) &&
      hiPct >= 0.0012
    ) {
      return sanitize({
        ...defaultDeskCalibration(),
        enabled_regimes: raw.enabled_regimes,
      });
    }
    const sanitized = sanitize(raw);
    const hasCompress = sanitized.enabled_regimes.includes('COMPRESSION');
    const hasTrans = sanitized.enabled_regimes.includes('TRANSITION');
    if (!hasCompress || !hasTrans) {
      return sanitize({
        ...sanitized,
        enabled_regimes: [...TRADABLE_DEFAULT],
      });
    }
    return sanitized;
  } catch {
    return defaultDeskCalibration();
  }
}

function saveToDisk(clientId: number, cfg: DeskCalibration): void {
  const file = calibrationPath(clientId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8');
}

/**
 * Soft / Peak / Target / SAFETY / entry-filter — BrainGenome SoT.
 * Manual PUT /api/desk/calibration must not write these (strips them).
 * AutoCal + setBrainGenome may still update via setDeskCalibration.
 */
export const BRAIN_OWNED_DESK_KEYS = [
  'hardinv_abs',
  'soft_l1_abs',
  'soft_l2_abs',
  'soft_l3_abs',
  'peak_mfe_abs',
  'peak_retention',
  'peak_min_giveback_abs',
  'target_abs',
  'target_l1_abs',
  'target_l2_abs',
  'target_l3_abs',
  'safety_tp_rr',
  'hardinv_pct',
  'target_pct',
  'peak_mfe_pct',
  'entry_filter_level',
] as const satisfies ReadonlyArray<keyof DeskCalibration>;

const BRAIN_OWNED_DESK_KEY_SET = new Set<string>(BRAIN_OWNED_DESK_KEYS);

/** Drop Soft/Peak/Target/SAFETY knobs from a manual desk PATCH. */
export function stripBrainOwnedDeskKnobs(
  partial: Partial<DeskCalibration>
): Partial<DeskCalibration> {
  const out: Partial<DeskCalibration> = {};
  for (const [k, v] of Object.entries(partial)) {
    if (BRAIN_OWNED_DESK_KEY_SET.has(k)) continue;
    if (k === 'updated_at') continue;
    (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

export function getDeskCalibration(clientId?: number | null): DeskCalibration {
  const id = resolveDeskClientId(clientId);
  let cached = cacheByClient.get(id);
  if (!cached) {
    cached = loadFromDisk(id);
    cacheByClient.set(id, cached);
  }
  // Genome wins Soft/Peak/Target/SAFETY + regime gates; desk file still persists.
  return mergeGenomeOverDesk(cached);
}

/**
 * Overlay BrainGenome trading knobs onto a desk snapshot.
 * Soft L1–L3, Target L1–L3, peak_*, pct, safety_tp_rr, filters, regimes.
 */
function mergeGenomeOverDesk(desk: DeskCalibration): DeskCalibration {
  const knobs = deskKnobsFromGenome();
  return sanitize({
    ...desk,
    ...knobs,
    enabled_regimes: knobs.enabled_regimes as RegimeName[],
    soft_off_regimes: knobs.soft_off_regimes as RegimeName[],
    updated_at: desk.updated_at,
  });
}

export function setDeskCalibration(
  partial: Partial<DeskCalibration>,
  clientId?: number | null
): DeskCalibration {
  const id = resolveDeskClientId(clientId);
  // Merge onto raw desk (not genome-overlaid) so operator/auto-cal writes persist.
  let raw = cacheByClient.get(id);
  if (!raw) {
    raw = loadFromDisk(id);
    cacheByClient.set(id, raw);
  }
  const next = sanitize({ ...raw, ...partial });
  cacheByClient.set(id, next);
  saveToDisk(id, next);
  // Keep BrainGenome in sync — genome is SoT on subsequent reads.
  syncDeskKnobsToGenome(next, partial);
  return mergeGenomeOverDesk(next);
}

/** Push desk trading knobs into genome when setDeskCalibration touches them. */
function syncDeskKnobsToGenome(
  next: DeskCalibration,
  partial: Partial<DeskCalibration>
): void {
  const keys = Object.keys(partial);
  if (!keys.length) return;
  const touch =
    keys.some((k) =>
      [
        'hardinv_abs',
        'soft_l1_abs',
        'soft_l2_abs',
        'soft_l3_abs',
        'peak_mfe_abs',
        'peak_retention',
        'peak_min_giveback_abs',
        'target_abs',
        'target_l1_abs',
        'target_l2_abs',
        'target_l3_abs',
        'safety_tp_rr',
        'hardinv_pct',
        'target_pct',
        'peak_mfe_pct',
        'entry_filter_level',
        'enabled_regimes',
        'soft_off_regimes',
      ].includes(k)
    );
  if (!touch) return;
  const fracToBp = (frac: number) =>
    Math.round((Math.max(0, Number(frac) || 0) / 1e-4) * 10) / 10;
  try {
    setBrainGenome({
      soft_l1_abs: next.soft_l1_abs,
      soft_l2_abs: next.soft_l2_abs,
      soft_l3_abs: next.soft_l3_abs,
      hardinv_abs_cap: next.hardinv_abs,
      hardinv_pct_bp: fracToBp(next.hardinv_pct),
      peak_mfe_abs: next.peak_mfe_abs,
      peak_mfe_pct_bp: fracToBp(next.peak_mfe_pct),
      // One Keep — desk retention writes both aliases
      peak_keep: next.peak_retention,
      peak_retention: next.peak_retention,
      peak_min_giveback_abs: next.peak_min_giveback_abs,
      target_l1_abs: next.target_l1_abs,
      target_l2_abs: next.target_l2_abs,
      target_l3_abs: next.target_l3_abs,
      target_pct_bp: fracToBp(next.target_pct),
      safety_tp_rr: next.safety_tp_rr,
      entry_filter_level: next.entry_filter_level,
      enabled_regimes: [...next.enabled_regimes],
      soft_off_regimes: [...next.soft_off_regimes],
    });
  } catch {
    /* genome write best-effort — desk file still saved */
  }
}

/** True when this regime is fully ON (enabled list). */
export function regimeAllowedForEntry(
  regime?: string | null,
  clientId?: number | null
): boolean {
  const r = String(regime || '')
    .trim()
    .toUpperCase();
  if (!r || r === 'UNKNOWN') return false;
  const cfg = getDeskCalibration(clientId);
  if (!cfg.enabled_regimes.length) return false;
  return cfg.enabled_regimes.includes(r as RegimeName);
}

/** Soft OFF — auto-cal demoted; strong signal may still enter. */
export function regimeIsSoftOff(
  regime?: string | null,
  clientId?: number | null
): boolean {
  const r = String(regime || '')
    .trim()
    .toUpperCase();
  if (!r || r === 'UNKNOWN') return false;
  if (regimeAllowedForEntry(r, clientId)) return false;
  const cfg = getDeskCalibration(clientId);
  return cfg.soft_off_regimes.includes(r as RegimeName);
}

/**
 * Entry gate: ON → allow; Soft OFF + strong → allow; Hard OFF → block.
 * Pass strong=true only after isStrongEntrySignal confirmed.
 */
export function regimeEntryPermitted(
  regime?: string | null,
  opts?: { strong?: boolean; clientId?: number | null }
): boolean {
  const clientId = opts?.clientId;
  if (regimeAllowedForEntry(regime, clientId)) return true;
  if (opts?.strong && regimeIsSoftOff(regime, clientId)) return true;
  return false;
}

/** Test helper — clear all client caches. */
export function _resetDeskCalibrationCacheForTests(): void {
  cacheByClient.clear();
}

export function deskCalibrationCatalog() {
  return {
    regimes: [...REGIME_NAMES],
    wait_only: ['UNKNOWN'],
    open_at_start: true,
    tradable_default: [...TRADABLE_DEFAULT],
    /** Soft/Peak/Target/SAFETY — read-only on desk PUT; Genome / AutoCal own writes. */
    brain_owned_knobs: [...BRAIN_OWNED_DESK_KEYS],
    /** Operator may still toggle regime allowlist (kill / reopen). */
    operator_knobs: ['enabled_regimes', 'soft_off_regimes'],
    knobs: [
      'hardinv_abs',
      'soft_l1_abs',
      'soft_l2_abs',
      'soft_l3_abs',
      'hardinv_pct',
      'peak_mfe_abs',
      'peak_mfe_pct',
      'peak_retention',
      'peak_min_giveback_abs',
      'target_abs',
      'target_l1_abs',
      'target_l2_abs',
      'target_l3_abs',
      'target_pct',
      'safety_tp_rr',
      'entry_filter_level',
      'enabled_regimes',
      'soft_off_regimes',
    ],
  };
}
