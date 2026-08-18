/**
 * P3 — Explicit REAL MARKET → normalize → strategy → setup → decision → risk → TradeIntent.
 * No fake success. Each stage returns a typed outcome; breaks surface as NO_SETUP / BLOCKED_TECHNICAL / ERROR_*.
 * Diagnostic/AAA helper — live opener is C++ calc EntryReady → enterTrade in robotDesk.
 */
import { DecisionCodes, type DecisionCode } from './decisionCodes.js';
import type { CapitalMarketQuote } from './capitalCom.js';
import {
  decideEntryFrom10sRegime,
  denyWithTrendEntry,
  effectiveBias,
  type TrendBias,
} from './entryFromRegime.js';
import type { RegimeName } from './regimes.js';
import { detectStaleQuoteAdverse, type PriceRef } from './staleQuoteGuard.js';
import type { TenSecBar } from './tenSecondOhlc.js';

export type NormalizedMarket = {
  epic: string;
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  market_status: string | null;
  feed_age_ms: number | null;
  update_time: string | null;
};

export type TradeIntent = {
  client_order_id_hint?: string;
  epic: string;
  direction: 'BUY' | 'SELL';
  size: number;
  reason: string;
  setup_type: string | null;
  mid: number;
  stop_hint?: 'percent_0_20';
};

export type PipelineStage =
  | 'MARKET'
  | 'NORMALIZE'
  | 'STRATEGY'
  | 'SETUP'
  | 'DECISION'
  | 'RISK'
  | 'INTENT'
  | 'EXECUTION';

export type PipelineResult =
  | {
      ok: true;
      stage: 'INTENT';
      code: typeof DecisionCodes.SIGNAL_CREATED | typeof DecisionCodes.RISK_ACCEPTED;
      intent: TradeIntent;
      normalized: NormalizedMarket;
      detail: string;
    }
  | {
      ok: false;
      stage: PipelineStage;
      code: DecisionCode;
      detail: string;
      normalized?: NormalizedMarket;
    };

export type PipelineInput = {
  quote: CapitalMarketQuote;
  epic: string;
  lot_size: number;
  regime: RegimeName;
  just_closed_bar: TenSecBar | null;
  recent_bars?: TenSecBar[] | null;
  bar_forming: boolean;
  trend_bias: TrendBias;
  trading_enabled: boolean;
  entry_enabled: boolean;
  feed_age_ms: number | null;
  max_spread?: number | null;
  fresher_refs?: PriceRef[];
  late_move?: boolean;
  open_position?: boolean;
  /** Operator STOP — block new entries */
  stopped?: boolean;
};

const TRADEABLE = new Set(['TRADEABLE', 'OPEN', 'ON']);

export function normalizeMarketQuote(
  quote: CapitalMarketQuote,
  epic: string,
  feedAgeMs: number | null
): { ok: true; normalized: NormalizedMarket } | { ok: false; code: DecisionCode; detail: string } {
  if (!quote.raw_ok) {
    return {
      ok: false,
      code: DecisionCodes.ERROR_NO_QUOTE,
      detail: quote.detail || 'Capital quote not raw_ok',
    };
  }
  const bid = quote.bid;
  const ask = quote.ask;
  const mid = quote.mid;
  if (bid == null || ask == null || mid == null || !Number.isFinite(mid)) {
    return {
      ok: false,
      code: DecisionCodes.ERROR_NO_QUOTE,
      detail: 'Missing bid/ask/mid after Capital snapshot',
    };
  }
  const spread = ask - bid;
  return {
    ok: true,
    normalized: {
      epic: quote.epic || epic,
      bid,
      ask,
      mid,
      spread,
      market_status: quote.market_status,
      feed_age_ms: feedAgeMs,
      update_time: quote.update_time,
    },
  };
}

export function runTradePipeline(input: PipelineInput): PipelineResult {
  if (input.stopped || !input.trading_enabled) {
    return {
      ok: false,
      stage: 'MARKET',
      code: DecisionCodes.BLOCKED_TECHNICAL,
      detail: 'STOP / trading_enabled=false — no new orders',
    };
  }
  if (!input.entry_enabled) {
    return {
      ok: false,
      stage: 'MARKET',
      code: DecisionCodes.BLOCKED_TECHNICAL,
      detail: 'entry_enabled=false — manage only',
    };
  }
  if (input.open_position) {
    return {
      ok: false,
      stage: 'MARKET',
      code: DecisionCodes.DUPLICATE_PREVENTED,
      detail: 'Open position exists — ONE TRADE ONLY',
    };
  }

  const norm = normalizeMarketQuote(input.quote, input.epic, input.feed_age_ms);
  if (!norm.ok) {
    return { ok: false, stage: 'NORMALIZE', code: norm.code, detail: norm.detail };
  }
  const n = norm.normalized;

  const status = (n.market_status || '').toUpperCase();
  if (status && !TRADEABLE.has(status) && status !== 'UNKNOWN') {
    return {
      ok: false,
      stage: 'NORMALIZE',
      code: DecisionCodes.MARKET_CLOSED,
      detail: `marketStatus=${n.market_status}`,
      normalized: n,
    };
  }

  if (n.feed_age_ms != null && n.feed_age_ms > 15_000) {
    return {
      ok: false,
      stage: 'NORMALIZE',
      code: DecisionCodes.STALE_PRICE,
      detail: `feed_age_ms=${n.feed_age_ms}`,
      normalized: n,
    };
  }

  if (input.max_spread != null && n.spread > input.max_spread) {
    return {
      ok: false,
      stage: 'NORMALIZE',
      code: DecisionCodes.BLOCKED_TECHNICAL,
      detail: `spread=${n.spread} > max=${input.max_spread}`,
      normalized: n,
    };
  }

  if (input.bar_forming || !input.just_closed_bar) {
    return {
      ok: false,
      stage: 'STRATEGY',
      code: DecisionCodes.NO_SETUP,
      detail: 'Waiting for 10s bar close',
      normalized: n,
    };
  }

  const bar = input.just_closed_bar;
  const bias = effectiveBias(input.regime, input.trend_bias, bar);
  const entry = decideEntryFrom10sRegime(bar, input.regime, bias, input.recent_bars);

  if (!entry) {
    const fade =
      input.regime === 'RANGE' ||
      input.regime === 'REVERSAL_CANDIDATE' ||
      input.regime === 'FAILED_BREAKOUT_UP' ||
      input.regime === 'FAILED_BREAKOUT_DOWN';
    return {
      ok: false,
      stage: 'SETUP',
      code: fade ? DecisionCodes.NO_SETUP : DecisionCodes.NO_SETUP,
      detail: fade ? `No fade/reversal entries (${input.regime})` : 'No with-trend setup on closed 10s',
      normalized: n,
    };
  }

  const deny = denyWithTrendEntry(entry.direction, bar, bias, input.recent_bars);
  if (deny) {
    return {
      ok: false,
      stage: 'DECISION',
      code: DecisionCodes.NO_SETUP,
      detail: deny,
      normalized: n,
    };
  }

  if (input.fresher_refs && input.fresher_refs.length > 0) {
    const stale = detectStaleQuoteAdverse(entry.direction, n.mid, input.fresher_refs);
    if (stale.block) {
      return {
        ok: false,
        stage: 'DECISION',
        code: DecisionCodes.STALE_PRICE,
        detail: stale.reason,
        normalized: n,
      };
    }
  }

  if (input.late_move) {
    return {
      ok: false,
      stage: 'DECISION',
      code: DecisionCodes.NO_SETUP,
      detail: 'Late move on 1m — skip entry',
      normalized: n,
    };
  }

  if (!(input.lot_size > 0) || !Number.isFinite(input.lot_size)) {
    return {
      ok: false,
      stage: 'RISK',
      code: DecisionCodes.RISK_REJECTED,
      detail: `Invalid lot_size=${input.lot_size}`,
      normalized: n,
    };
  }

  const intent: TradeIntent = {
    epic: n.epic,
    direction: entry.direction,
    size: input.lot_size,
    reason: entry.reason,
    setup_type: entry.setup,
    mid: n.mid,
    stop_hint: 'percent_0_20',
  };

  return {
    ok: true,
    stage: 'INTENT',
    code: DecisionCodes.SIGNAL_CREATED,
    intent,
    normalized: n,
    detail: `TradeIntent ${intent.direction} ${intent.epic} lot=${intent.size}`,
  };
}

/** Map unexplained outcomes — never leave as WAIT without reason. */
export function unresolvedPipelineError(detail: string): PipelineResult {
  return {
    ok: false,
    stage: 'DECISION',
    code: DecisionCodes.ERROR_STATE_UNRESOLVED,
    detail: detail || 'State unresolved — no WAIT without reason',
  };
}
