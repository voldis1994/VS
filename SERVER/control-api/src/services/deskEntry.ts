/**
 * Desk entry: 10s regime, then Capital-lag lead (BUY and SELL).
 * Does not invent a side on every dump/rally — that churns Gold 10s.
 */
import {
  decideEntryFrom10sRegime,
  denyWithTrendEntry,
  blockLateCalcEntry,
  type TrendBias,
} from './entryFromRegime.js';
import {
  detectCapitalLagLead,
  detectStaleQuoteAdverse,
  LAG_SCAN_MIN_REL,
  type PriceRef,
} from './staleQuoteGuard.js';
import type { TenSecBar } from './tenSecondOhlc.js';

export type DeskEntry = {
  direction: 'BUY' | 'SELL' | null;
  setup: string | null;
  reason: string;
};

const FLIP_MIN_REL = 0.0012;

export function resolveDeskEntry(input: {
  intended?: 'BUY' | 'SELL' | null;
  intendedSetup?: string | null;
  intendedReason?: string;
  bar?: TenSecBar | null;
  regime?: string | null;
  bias?: TrendBias;
  closedBars?: TenSecBar[] | null;
  capitalMid: number | null | undefined;
  refs: PriceRef[];
}): DeskEntry {
  let direction: 'BUY' | 'SELL' | null = input.intended ?? null;
  let setup: string | null = input.intendedSetup ?? null;
  let reason = input.intendedReason ?? '';
  const bias = input.bias || 'FLAT';

  // When bias is FLAT, infer concept direction from the lasting 1m regime.
  // This avoids countertrend LAG_LEAD/stale flips during “bias uncertainty”.
  function conceptBiasFromRegime(regime?: string | null): TrendBias {
    const r = String(regime || '').toUpperCase();
    const up = r === 'TREND_UP' || r === 'PULLBACK_UPTREND' || r === 'BREAKOUT_UP';
    const down = r === 'TREND_DOWN' || r === 'PULLBACK_DOWNTREND' || r === 'BREAKOUT_DOWN';
    if (up) return 'UP';
    if (down) return 'DOWN';
    return 'FLAT';
  }

  // When direction came from C++ EntryReady, do not override it with Node-side
  // lag/leak heuristics — that would discard EV/transition formulas from calc.
  const fromCalc = input.intended != null;

  // Concept permission gate:
  // With-trend setups must align with the lasting bias (1m concept).
  // If C++ intended a with-trend direction against bias, block the entry.
  const conceptBias = bias === 'FLAT' ? conceptBiasFromRegime(input.regime) : bias;
  if (fromCalc && direction && conceptBias !== 'FLAT') {
    const s = String(input.intendedSetup || '')
      .trim()
      .toUpperCase();
    const withTrend = new Set(['PULLBACK', 'CONTINUATION', 'BREAKOUT']);
    if (withTrend.has(s)) {
      const ok = conceptBias === 'UP' ? direction === 'BUY' : direction === 'SELL';
      if (!ok) {
        return {
          direction: null,
          setup: null,
          reason: `CONCEPT_BLOCK · with-trend ${s} vs bias ${conceptBias}`,
        };
      }
    }
  }

  if (fromCalc && direction && input.bar) {
    const setupU = String(setup || '').toUpperCase();
    const late = blockLateCalcEntry(direction, input.bar, input.closedBars);
    if (late) {
      return { direction: null, setup: null, reason: `CALC_BLOCK · ${late}` };
    }
    const deny = denyWithTrendEntry(direction, input.bar, bias, input.closedBars, {
      exhaustion: setupU === 'FADE',
      allowCountertrend: ['FADE', 'REVERSAL', 'RANGE_REJECTION', 'FAILED_BREAKOUT'].includes(setupU),
    });
    if (deny) {
      return { direction: null, setup: null, reason: `CALC_BLOCK · ${deny}` };
    }
  }

  if (!direction && input.bar) {
    const hit = decideEntryFrom10sRegime(
      input.bar,
      input.regime,
      bias,
      input.closedBars
    );
    if (hit) {
      direction = hit.direction;
      setup = hit.setup;
      reason = `10s ${hit.setup} · ${hit.reason}`;
    }
  }

  function lagConceptAllowed(lagDir: 'BUY' | 'SELL'): boolean {
    const cb = bias === 'FLAT' ? conceptBiasFromRegime(input.regime) : bias;
    if (cb === 'FLAT') return true;
    if (cb === 'UP') return lagDir === 'BUY';
    return lagDir === 'SELL';
  }

  function lagEvidenceAllowed(lagDir: 'BUY' | 'SELL', bar?: TenSecBar | null): boolean {
    // In SCAN mode we may not have a 10s candle; then we can't validate dip/rally evidence.
    if (!bar) return true;

    // Block “BUY/SELL on a doji”.
    const denom = Math.max(Math.abs(bar.open), 1e-9);
    const bodyAbsRel = Math.abs(bar.close - bar.open) / denom;
    if (bodyAbsRel < 0.00002) return false;

    // Minimal dip/rally evidence: green → BUY, red → SELL.
    if (lagDir === 'BUY') return bar.close > bar.open;
    return bar.close < bar.open;
  }

  const lead = detectCapitalLagLead(input.capitalMid, input.refs, {
    // Keep original scan threshold (avoid false-negative on real clusters).
    // Flip protection still uses the higher threshold when direction already exists.
    minRel: direction ? FLIP_MIN_REL : LAG_SCAN_MIN_REL,
  });

  let lagBlockedReason: string | null = null;
  if (lead.hit && lead.direction) {
    const lagDir = lead.direction;
    const conceptOk = lagConceptAllowed(lagDir);
    const evidenceOk = lagEvidenceAllowed(lagDir, input.bar);

    if (!conceptOk) {
      lagBlockedReason = `CONCEPT_BLOCK · LAG_LEAD ${lagDir} vs bias ${bias}`;
    } else if (!evidenceOk) {
      lagBlockedReason = `EVIDENCE_BLOCK · LAG_LEAD ${lagDir} vs 10s candle`;
    } else if (!direction) {
      return { direction: lagDir, setup: 'LAG_LEAD', reason: lead.reason };
    } else if (!fromCalc && direction !== lagDir) {
      return {
        direction: lagDir,
        setup: 'LAG_LEAD',
        reason: `FLIP ${direction} → ${lead.reason}`,
      };
    }
  }

  if (direction && setup !== 'LAG_LEAD') {
    const stale = detectStaleQuoteAdverse(direction, input.capitalMid, input.refs);
    if (stale.block) {
      // If C++ already gave an intended side, do not flip it; block the entry instead.
      if (fromCalc) {
        return { direction: null, setup: null, reason: `STALE_QUOTE_BLOCK · ${stale.reason}` };
      }

      const flip: 'BUY' | 'SELL' = direction === 'BUY' ? 'SELL' : 'BUY';
      const conceptOk = lagConceptAllowed(flip);
      const evidenceOk = lagEvidenceAllowed(flip, input.bar);

      if (conceptOk && evidenceOk) {
        return {
          direction: flip,
          setup: 'LAG_LEAD',
          reason: `LAG CAPITAL · ${flip} · ${stale.reason}`,
        };
      }

      const why = !conceptOk
        ? `CONCEPT_BLOCK · LAG_LEAD ${flip} vs bias ${bias}`
        : `EVIDENCE_BLOCK · LAG_LEAD ${flip} vs 10s candle`;
      return { direction: null, setup: null, reason: `${why} · ${stale.reason}` };
    }
  }

  // Last resort only in a lasting trend — RANGE/COMPRESSION must not flip every 10s.
  if (!direction && input.bar) {
    // Avoid “BUY/SELL on a doji”: last-resort bias should require real body movement.
    const bar = input.bar;
    const denom = Math.max(Math.abs(bar.open), 1e-9);
    const bodyAbsRel = Math.abs(bar.close - bar.open) / denom;
    if (bodyAbsRel < 0.00002) {
      return { direction: null, setup: null, reason: '' };
    }

    const regime = String(input.regime || '').toUpperCase();
    const trendingBuy =
      regime === 'TREND_UP' || regime === 'PULLBACK_UPTREND' || regime === 'BREAKOUT_UP';
    const trendingSell =
      regime === 'TREND_DOWN' || regime === 'PULLBACK_DOWNTREND' || regime === 'BREAKOUT_DOWN';
    if (trendingBuy && bias !== 'DOWN') {
      return {
        direction: 'BUY',
        setup: 'BIAS',
        reason: `BIAS ${bias} · BUY · ${input.regime || 'UNKNOWN'} closed 10s`,
      };
    }
    if (trendingSell && bias !== 'UP') {
      return {
        direction: 'SELL',
        setup: 'BIAS',
        reason: `BIAS ${bias} · SELL · ${input.regime || 'UNKNOWN'} closed 10s`,
      };
    }
  }

  if (!direction && !setup && lagBlockedReason) {
    reason = lagBlockedReason;
  }

  return { direction, setup, reason };
}
