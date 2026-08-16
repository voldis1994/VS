/**
 * Position management measurements — MFE/MAE/peak/giveback.
 * Exit decisions use only information available at timestamp (no look-ahead).
 */

export type PositionExcursion = {
  entry: number;
  direction: 'LONG' | 'SHORT';
  current: number;
  peak_price: number;
  peak_profit: number;
  current_profit: number;
  mfe: number;
  mae: number;
  giveback: number;
  giveback_ratio: number | null;
  peak_profit_pct: number;
  distance_from_peak: number;
};

export function updateExcursion(input: {
  entry: number;
  direction: 'LONG' | 'SHORT';
  current: number;
  peak_price: number;
  mfe: number;
  mae: number;
}): PositionExcursion {
  const signed =
    input.direction === 'LONG' ? input.current - input.entry : input.entry - input.current;
  const peakFavorable =
    input.direction === 'LONG'
      ? Math.max(input.peak_price, input.current)
      : Math.min(input.peak_price, input.current);
  const peakProfit =
    input.direction === 'LONG' ? peakFavorable - input.entry : input.entry - peakFavorable;
  const mfe = Math.max(input.mfe, Math.max(0, signed));
  const mae = Math.min(input.mae, Math.min(0, signed));
  const giveback = Math.max(0, peakProfit - Math.max(0, signed));
  const givebackRatio = peakProfit > 0 ? giveback / peakProfit : null;
  return {
    entry: input.entry,
    direction: input.direction,
    current: input.current,
    peak_price: peakFavorable,
    peak_profit: peakProfit,
    current_profit: signed,
    mfe,
    mae,
    giveback,
    giveback_ratio: givebackRatio,
    peak_profit_pct: peakProfit / Math.max(Math.abs(input.entry), 1e-9),
    distance_from_peak: Math.abs(input.current - peakFavorable),
  };
}

export type ExitCandidate = 'HOLD' | 'PARTIAL_EXIT' | 'MOVE_SL' | 'TRAIL' | 'FULL_EXIT';

/**
 * Best-outcome exit ranking using only current evidence (no future prices).
 */
export function rankExitCandidates(input: {
  excursion: PositionExcursion;
  momentum_score: number | null;
  structure_deteriorating: boolean;
  spread_deteriorating: boolean;
  giveback_ratio_threshold?: number;
}): Array<{ action: ExitCandidate; score: number; reason: string }> {
  const thr = input.giveback_ratio_threshold ?? 0.45;
  const candidates: Array<{ action: ExitCandidate; score: number; reason: string }> = [];

  candidates.push({
    action: 'HOLD',
    score:
      (input.momentum_score != null &&
      Math.sign(input.momentum_score) === (input.excursion.direction === 'LONG' ? 1 : -1)
        ? 0.6
        : 0.3) + (input.structure_deteriorating ? -0.3 : 0.1),
    reason: 'momentum/structure persistence',
  });

  if (input.excursion.giveback_ratio != null && input.excursion.giveback_ratio >= thr) {
    candidates.push({
      action: 'FULL_EXIT',
      score: 0.55 + input.excursion.giveback_ratio,
      reason: `giveback_ratio ${input.excursion.giveback_ratio.toFixed(2)} ≥ ${thr}`,
    });
  } else {
    candidates.push({
      action: 'FULL_EXIT',
      score: input.structure_deteriorating ? 0.5 : 0.1,
      reason: input.structure_deteriorating ? 'structure deteriorating' : 'no giveback trigger',
    });
  }

  candidates.push({
    action: 'MOVE_SL',
    score: input.excursion.peak_profit > 0 && !input.structure_deteriorating ? 0.45 : 0.15,
    reason: 'lock progress without full exit',
  });

  candidates.push({
    action: 'TRAIL',
    score: input.excursion.mfe > 0 && (input.momentum_score ?? 0) !== 0 ? 0.4 : 0.1,
    reason: 'trail while momentum persists',
  });

  candidates.push({
    action: 'PARTIAL_EXIT',
    score: input.excursion.peak_profit_pct > 0.002 ? 0.35 : 0.05,
    reason: 'scale out after proven excursion',
  });

  if (input.spread_deteriorating) {
    for (const c of candidates) {
      if (c.action === 'FULL_EXIT') c.score += 0.2;
      if (c.action === 'HOLD') c.score -= 0.2;
    }
  }

  return candidates.sort((a, b) => b.score - a.score);
}
