/**
 * Desk entry: real 10s setups only (PULLBACK / CONTINUATION / BREAKOUT / rejection).
 * Does not chase every dump/rally via BIAS or LAG_LEAD alone.
 */
import {
  decideEntryFrom10sRegime,
  denyWithTrendEntry,
  blockLateCalcEntry,
  type TrendBias,
} from './entryFromRegime.js';
import {
  evaluateEntryDirectionGate,
  formatEntryDiagnostic,
} from './entryDirectionGate.js';
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

const COUNTERTREND_SETUPS = new Set([
  'FADE',
  'REVERSAL',
  'RANGE_REJECTION',
  'FAILED_BREAKOUT',
]);

/** Named structure setups that may open Capital — not BIAS / LAG chase. */
const REAL_ENTRY_SETUPS = [
  'PULLBACK',
  'CONTINUATION',
  'BREAKOUT',
  'RANGE_REJECTION',
  'FADE',
  'REVERSAL',
  'FAILED_BREAKOUT',
] as const;

export function isRealEntrySetup(setup?: string | null): boolean {
  const s = String(setup || '')
    .trim()
    .toUpperCase();
  if (!s) return false;
  return REAL_ENTRY_SETUPS.some((ok) => s === ok || s.includes(ok));
}

/** Hard block: no BUY in down regime/bias, no SELL in up regime/bias. */
export function blockRegimeDirectionEntry(
  direction: 'BUY' | 'SELL',
  regime?: string | null,
  bias: TrendBias = 'FLAT',
  _setup?: string | null
): string | null {
  const r = String(regime || '').toUpperCase();
  const downCtx =
    r.includes('TREND_DOWN') || r.includes('PULLBACK_DOWN') || r.includes('BREAKOUT_DOWN');
  const upCtx = r.includes('TREND_UP') || r.includes('PULLBACK_UP') || r.includes('BREAKOUT_UP');

  // Explicit bias wins over regime label (e.g. PULLBACK_UPTREND + bias DOWN → SELL OK).
  if (direction === 'BUY' && (bias === 'DOWN' || (downCtx && bias !== 'UP'))) {
    return `REGIME_BLOCK · BUY forbidden in ${downCtx ? r : `bias ${bias}`}`;
  }
  if (direction === 'SELL' && (bias === 'UP' || (upCtx && bias !== 'DOWN'))) {
    return `REGIME_BLOCK · SELL forbidden in ${upCtx ? r : `bias ${bias}`}`;
  }
  return null;
}

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

  // When bias is FLAT, infer concept direction from the lasting regime.
  function conceptBiasFromRegime(regime?: string | null): TrendBias {
    const r = String(regime || '').toUpperCase();
    const up = r === 'TREND_UP' || r === 'PULLBACK_UPTREND' || r === 'BREAKOUT_UP';
    const down = r === 'TREND_DOWN' || r === 'PULLBACK_DOWNTREND' || r === 'BREAKOUT_DOWN';
    if (up) return 'UP';
    if (down) return 'DOWN';
    return 'FLAT';
  }

  const conceptBias = bias === 'FLAT' ? conceptBiasFromRegime(input.regime) : bias;

  function finish(entry: DeskEntry): DeskEntry {
    if (!entry.direction) return entry;
    if (!isRealEntrySetup(entry.setup)) {
      return {
        direction: null,
        setup: null,
        reason: `NO_REAL_SETUP · ${entry.setup || 'none'} is not a tradeable structure`,
      };
    }
    const regimeBlock = blockRegimeDirectionEntry(
      entry.direction,
      input.regime,
      conceptBias !== 'FLAT' ? conceptBias : bias,
      entry.setup
    );
    if (regimeBlock) {
      return { direction: null, setup: null, reason: regimeBlock };
    }
    if (conceptBias !== 'FLAT') {
      const s = String(entry.setup || '')
        .trim()
        .toUpperCase();
      if (
        !COUNTERTREND_SETUPS.has(s) &&
        !s.includes('FAILED_BREAKOUT') &&
        !s.includes('RANGE_REJECTION')
      ) {
        const ok = conceptBias === 'UP' ? entry.direction === 'BUY' : entry.direction === 'SELL';
        if (!ok) {
          return {
            direction: null,
            setup: null,
            reason: `CONCEPT_BLOCK · ${entry.direction} vs bias ${conceptBias}${s ? ` · ${s}` : ''}`,
          };
        }
      }
    }
    const trendGate = evaluateEntryDirectionGate({
      direction: entry.direction,
      closedBars: input.closedBars,
      bar: input.bar,
      regime: input.regime,
      bias: conceptBias !== 'FLAT' ? conceptBias : bias,
      setup: entry.setup,
    });
    if (trendGate.final_entry === 'BLOCK') {
      return {
        direction: null,
        setup: null,
        reason: `TREND_GATE · ${trendGate.block_reason} · ${formatEntryDiagnostic(trendGate)}`,
      };
    }
    return entry;
  }

  const fromCalc = input.intended != null;

  if (fromCalc && direction) {
    const regimeBlock = blockRegimeDirectionEntry(
      direction,
      input.regime,
      conceptBias !== 'FLAT' ? conceptBias : bias,
      setup
    );
    if (regimeBlock) {
      return { direction: null, setup: null, reason: regimeBlock };
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
      allowCountertrend: ['FADE', 'REVERSAL', 'RANGE_REJECTION', 'FAILED_BREAKOUT'].includes(
        setupU
      ),
    });
    if (deny) {
      return { direction: null, setup: null, reason: `CALC_BLOCK · ${deny}` };
    }
  }

  if (!direction && input.bar) {
    const hit = decideEntryFrom10sRegime(input.bar, input.regime, bias, input.closedBars);
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
    if (!bar) return true;
    const denom = Math.max(Math.abs(bar.open), 1e-9);
    const bodyAbsRel = Math.abs(bar.close - bar.open) / denom;
    if (bodyAbsRel < 0.00002) return false;
    if (lagDir === 'BUY') return bar.close > bar.open;
    return bar.close < bar.open;
  }

  const lead = detectCapitalLagLead(input.capitalMid, input.refs, {
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
      lagBlockedReason = `NO_REAL_SETUP · LAG_LEAD alone blocked · ${lead.reason}`;
    } else if (!fromCalc && direction !== lagDir) {
      return {
        direction: null,
        setup: null,
        reason: `STALE_LAG_BLOCK · ${lead.reason}`,
      };
    }
  }

  if (direction && isRealEntrySetup(setup)) {
    const stale = detectStaleQuoteAdverse(direction, input.capitalMid, input.refs);
    if (stale.block) {
      return { direction: null, setup: null, reason: `STALE_QUOTE_BLOCK · ${stale.reason}` };
    }
  }

  if (!direction && !setup && lagBlockedReason) {
    reason = lagBlockedReason;
  }

  return finish({ direction, setup, reason });
}
