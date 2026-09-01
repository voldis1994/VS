/**
 * Price-scaled thresholds — same entry/exit brain on Gold, FX, Oil, indices.
 * Legacy absolute floors were tuned at Gold ~4430; scale linearly by price.
 */
const GOLD_REF = 4430;

export function refPx(px: number | null | undefined): number {
  const n = Number(px);
  return Number.isFinite(n) && n > 0 ? Math.abs(n) : GOLD_REF;
}

/** Map a Gold @4430 point distance to the same % move on any instrument. */
export function scaleFromGold(px: number | null | undefined, goldPoints: number): number {
  return refPx(px) * (goldPoints / GOLD_REF);
}

/** Swing edge band — % of price + span, not a hard 0.8pt on EURUSD. */
export function edgeEps(px: number, span: number): number {
  const r = refPx(px);
  return Math.max(r * 0.00035, span * 0.08, scaleFromGold(r, 0.8));
}

/** Minimum H–L before FADE/tip-chase — flat FX (H≈L) must not ARM FADE forever. */
export function minSwingSpan(px: number | null | undefined): number {
  const r = refPx(px);
  return Math.max(r * 0.00025, scaleFromGold(r, 0.35));
}

/** Scale playbook exit absolute floors (tpFloor, slFloor, mfeFloorAbs) for entry price. */
export function scaleExitFloors(
  px: number | null | undefined,
  params: {
    tpFloor: number;
    slFloor: number;
    mfeFloorAbs: number;
  }
): { tpFloor: number; slFloor: number; mfeFloorAbs: number } {
  const r = refPx(px);
  return {
    tpFloor: scaleFromGold(r, params.tpFloor),
    slFloor: scaleFromGold(r, params.slFloor),
    mfeFloorAbs: scaleFromGold(r, params.mfeFloorAbs),
  };
}
