/** Live Capital exit manager — per-robot, best-outcome + thesis failure from regime. */

export type ExitSide = 'BUY' | 'SELL';

export type ExitSnapshot = {
  open_side: ExitSide | null;
  entry_price: number | null;
  entry_at: string | null;
  mfe: number;
  mae: number;
  peak_retention: number | null;
  regime?: string | null;
};

export function favorableMove(side: ExitSide, entry: number, mid: number): number {
  return side === 'BUY' ? mid - entry : entry - mid;
}

/** Opposite breakout vs open side. Other regimes are OFF — no thesis from them. */
export function thesisFailureReason(
  side: ExitSide,
  regime?: string | null
): string | null {
  const r = String(regime || '')
    .trim()
    .toUpperCase();
  if (!r || r === 'UNKNOWN' || r === 'COMPRESSION') return null;
  // Breakout-only mode: only opposite BREAKOUT kills the thesis
  if (side === 'BUY' && r === 'BREAKOUT_DOWN') {
    return `ThesisFailure · BUY vs ${r}`;
  }
  if (side === 'SELL' && r === 'BREAKOUT_UP') {
    return `ThesisFailure · SELL vs ${r}`;
  }
  return null;
}

/**
 * Manage exit — Best Outcome first; broker SAFETY SL is last-resort only.
 * Soft exits (thesis / peak / harvest / time) ONLY when still green.
 * HardInvalidation closes via robot BEFORE Capital SL can fire.
 */
export function decideBestOutcomeExit(
  s: ExitSnapshot,
  mid: number
): { exit: boolean; reason: string } {
  if (!s.open_side || s.entry_price == null) return { exit: false, reason: '' };

  const entry = s.entry_price;
  const fav = favorableMove(s.open_side, entry, mid);
  const absEntry = Math.max(Math.abs(entry), 1e-9);
  // TP ≈ 0.28% — take Best Outcome earlier than waiting for Capital SL noise
  const tp = Math.max(absEntry * 0.0028, 0.28);
  // HardInvalidation ≈ 0.32% — robot closes BEFORE broker SAFETY SL (~0.50%)
  const sl = Math.max(absEntry * 0.0032, 0.32);
  // Arm peak/harvest from ≈1.4pt on Gold ~4600
  const mfeFloor = Math.max(absEntry * 0.0003, 0.08);
  // Min green to soft-exit (~0.18pt Gold)
  const minGreen = Math.max(absEntry * 0.00004, 0.1);

  if (fav <= -sl) {
    return { exit: true, reason: `HardInvalidation · UPL ${fav.toFixed(5)} ≤ -SL ${sl.toFixed(5)}` };
  }

  // Soft exits only while green enough
  if (fav < minGreen) {
    return { exit: false, reason: '' };
  }

  const thesis = thesisFailureReason(s.open_side, s.regime);
  if (thesis) {
    return { exit: true, reason: `${thesis} · lock green ${fav.toFixed(5)}` };
  }

  if (s.mfe >= mfeFloor && s.peak_retention != null && s.peak_retention < 0.35) {
    return {
      exit: true,
      reason: `PeakProtection · retention ${(s.peak_retention * 100).toFixed(0)}% of MFE ${s.mfe.toFixed(5)} · UPL ${fav.toFixed(5)}`,
    };
  }

  if (fav >= tp) {
    return {
      exit: true,
      reason: `Target / best outcome · UPL ${fav.toFixed(5)} ≥ TP ${tp.toFixed(5)}`,
    };
  }

  if (s.mfe >= mfeFloor && s.peak_retention != null && s.peak_retention < 0.5) {
    return {
      exit: true,
      reason: `BestOutcome harvest · UPL ${fav.toFixed(5)} after MFE ${s.mfe.toFixed(5)} (ret ${(s.peak_retention * 100).toFixed(0)}%)`,
    };
  }

  const heldMs = s.entry_at ? Date.now() - new Date(s.entry_at).getTime() : 0;
  if (heldMs > 360_000 && s.mfe >= mfeFloor * 0.5) {
    return {
      exit: true,
      reason: `TimeDecay · held ${Math.round(heldMs / 1000)}s · realize green UPL ${fav.toFixed(5)}`,
    };
  }

  return { exit: false, reason: '' };
}

/** Operator-facing hold line when Best Outcome did not fire an exit. */
export function describeBestOutcomeState(
  s: ExitSnapshot,
  mid: number
): { exit: boolean; reason: string; hold: string } {
  const decision = decideBestOutcomeExit(s, mid);
  if (decision.exit) return { ...decision, hold: '' };

  if (!s.open_side || s.entry_price == null) {
    return {
      exit: false,
      reason: '',
      hold: 'BO blocked — missing entry_price (manage robot not seeded?)',
    };
  }

  const entry = s.entry_price;
  const fav = favorableMove(s.open_side, entry, mid);
  const absEntry = Math.max(Math.abs(entry), 1e-9);
  const sl = Math.max(absEntry * 0.0032, 0.32);
  const minGreen = Math.max(absEntry * 0.00004, 0.1);
  const mfeFloor = Math.max(absEntry * 0.0003, 0.08);
  const ret =
    s.peak_retention != null ? `${(s.peak_retention * 100).toFixed(0)}%` : '—';

  if (fav < minGreen) {
    return {
      exit: false,
      reason: '',
      hold: `BO idle (need green) · UPL ${fav.toFixed(2)} < ${minGreen.toFixed(2)} · HardInv @ -${sl.toFixed(2)} · MFE ${s.mfe.toFixed(2)}/${mfeFloor.toFixed(2)} · ret ${ret}`,
    };
  }

  return {
    exit: false,
    reason: '',
    hold: `BO armed · UPL ${fav.toFixed(2)} · MFE ${s.mfe.toFixed(2)} · ret ${ret} · waiting rule`,
  };
}
