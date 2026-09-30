/**
 * Soft HardInv ×3 + Target ×3 profit layers.
 *
 * Problem: one fat Soft/Target from a winning auto-cal window stays after the
 * market flips — Target never prints, Soft HardInv eats 5× and wipes the bank.
 *
 * Layers (desk-calibrated, Brain/auto-cal tune all 6):
 *   Soft L1 ≤ L2 ≤ L3(=hardinv_abs) — loss room unlocks with proven MFE
 *   Target L1 ≤ L2 ≤ L3(=target_abs) — bank at the layer the leg actually reached
 *
 * Soft: no green → L1 tight; MFE earns L2/L3 room (not old fat Soft from day one).
 * Target: hit L1/L2 without stretching toward L3 → bank that layer (no wait for fat T3).
 */
import { getDeskCalibration, type DeskCalibration } from './deskCalibration.js';
import { getBrainGenome } from '../brainSelfImprove/brainGenome.js';

export type LayerIndex = 1 | 2 | 3;

export type SoftTargetLayers = {
  soft: [number, number, number];
  target: [number, number, number];
};

function sortThree(a: number, b: number, c: number): [number, number, number] {
  const xs = [a, b, c].map((n) => Math.max(0.2, Number(n) || 0.2)).sort((x, y) => x - y);
  return [xs[0]!, xs[1]!, xs[2]!];
}

/** Read ordered Soft/Target abs layers from desk (L3 aliases hardinv/target). */
export function readSoftTargetLayers(
  cal: DeskCalibration = getDeskCalibration()
): SoftTargetLayers {
  const s3 = cal.hardinv_abs > 0 ? cal.hardinv_abs : 2.2;
  const s1 = cal.soft_l1_abs > 0 ? cal.soft_l1_abs : Math.round(s3 * 0.55 * 10) / 10;
  const s2 = cal.soft_l2_abs > 0 ? cal.soft_l2_abs : Math.round(s3 * 0.8 * 10) / 10;
  const t3 = cal.target_abs > 0 ? cal.target_abs : 5.0;
  const t1 = cal.target_l1_abs > 0 ? cal.target_l1_abs : Math.round(t3 * 0.5 * 10) / 10;
  const t2 = cal.target_l2_abs > 0 ? cal.target_l2_abs : Math.round(t3 * 0.7 * 10) / 10;
  return {
    soft: sortThree(s1, s2, s3),
    target: sortThree(t1, t2, t3),
  };
}

/**
 * Which Soft layer is unlocked by MFE (genome soft_layer_unlock_mult).
 * L1 always; L2 after MFE ≥ soft_l1×unlock; L3 after MFE ≥ soft_l2×unlock.
 */
export function unlockedSoftLayer(
  mfe: number,
  soft: [number, number, number],
  unlockMult?: number
): LayerIndex {
  const u = Math.max(
    0.5,
    Number(unlockMult ?? getBrainGenome().soft_layer_unlock_mult) || 1
  );
  if (mfe >= soft[1]! * u) return 3;
  if (mfe >= soft[0]! * u) return 2;
  return 1;
}

/** Active Soft HardInv abs (Gold pts) — widens only after proven MFE. */
export function activeSoftAbs(
  mfe: number,
  cal?: DeskCalibration
): { abs: number; layer: LayerIndex; soft: [number, number, number] } {
  const { soft } = readSoftTargetLayers(cal);
  const layer = unlockedSoftLayer(mfe, soft);
  return { abs: soft[layer - 1]!, layer, soft };
}

/**
 * Target layer exit — bank the layer the leg actually reached.
 * Fat L3 from old cal does not block banking L1/L2 when MFE never stretched.
 * `targetDists` must be in the same price-pt units as fav/mfe.
 */
export function targetLayerHit(opts: {
  fav: number;
  mfe: number;
  execFav: number;
  minBank: number;
  targetDists: [number, number, number];
}): { layer: LayerIndex; dist: number } | null {
  const { fav, mfe, execFav, minBank, targetDists } = opts;
  if (!(execFav >= minBank) || !(fav > 0)) return null;
  const [d1, d2, d3] = targetDists;
  if (fav >= d3) return { layer: 3, dist: d3 };
  if (fav >= d2 && mfe < d3 * 0.85) return { layer: 2, dist: d2 };
  if (fav >= d1 && mfe < d2 * 0.85) return { layer: 1, dist: d1 };
  return null;
}

/**
 * Suggest Soft/Target layer abs from a window of MFE / |loss| pts.
 * Auto-cal uses percentiles so L1 scalp / L2 mid / L3 runner stay coherent.
 */
export function suggestLayersFromExcursions(
  mfes: number[],
  lossAbs: number[],
  current: SoftTargetLayers
): SoftTargetLayers {
  const pos = mfes.filter((x) => x > 0.05).sort((a, b) => a - b);
  const neg = lossAbs.filter((x) => x > 0.05).sort((a, b) => a - b);
  const pct = (xs: number[], p: number, fallback: number) => {
    if (!xs.length) return fallback;
    const i = Math.min(xs.length - 1, Math.max(0, Math.floor((xs.length - 1) * p)));
    return Math.round(xs[i]! * 10) / 10;
  };
  let soft: [number, number, number] = [
    pct(neg, 0.35, current.soft[0]!),
    pct(neg, 0.6, current.soft[1]!),
    pct(neg, 0.85, current.soft[2]!),
  ];
  let target: [number, number, number] = [
    pct(pos, 0.35, current.target[0]!),
    pct(pos, 0.6, current.target[1]!),
    pct(pos, 0.85, current.target[2]!),
  ];
  soft = sortThree(soft[0]!, soft[1]!, soft[2]!);
  target = sortThree(target[0]!, target[1]!, target[2]!);
  target = sortThree(
    Math.max(target[0]!, soft[0]!),
    Math.max(target[1]!, soft[1]!),
    Math.max(target[2]!, soft[2]! * 1.2)
  );
  return { soft, target };
}
