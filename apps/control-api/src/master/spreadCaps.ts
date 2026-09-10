/**
 * Epic-aware spread caps — GOLD/SILVER floors (FX-tuned 1.5pt false-blocked Capital XAU).
 * Kept out of filters↔broker↔pipeline↔risk import cycle.
 */
import type { MasterConfig } from './types.js';

export function isMetalEpic(epic?: string | null): boolean {
  const e = String(epic || '')
    .trim()
    .toUpperCase();
  return (
    e === 'GOLD' ||
    e === 'SILVER' ||
    e.includes('XAU') ||
    e.includes('XAG')
  );
}

/** Effective abs/pct caps — metals get floors; FX keeps cfg as-is. */
export function effectiveSpreadCaps(
  cfg: MasterConfig,
  epic?: string | null
): { max_spread_abs: number; max_spread_pct: number; max_relative_spread: number } {
  if (!isMetalEpic(epic)) {
    return {
      max_spread_abs: cfg.max_spread_abs,
      max_spread_pct: cfg.max_spread_pct,
      max_relative_spread: cfg.max_relative_spread,
    };
  }
  return {
    // Capital GOLD often 0.4–2.5; 1.5 FX default blocked live setups
    max_spread_abs: Math.max(cfg.max_spread_abs, 3),
    // 0.1% of ~2600–4000 ≈ 2.6–4 pts
    max_spread_pct: Math.max(cfg.max_spread_pct, 0.001),
    // z-score: metals history is tight → tiny widenings look like huge spikes
    max_relative_spread: Math.max(cfg.max_relative_spread, 2.5),
  };
}
