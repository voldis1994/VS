/**
 * VS CORE Market Intelligence — canonical types.
 * Never invent prices. Operational blocks ≠ market regimes.
 */

export type OperationalBlock =
  | 'FEED_UNAVAILABLE'
  | 'INSUFFICIENT_DATA'
  | 'NO_SETUP'
  | 'DATA_QUALITY_BLOCK'
  | 'EMERGENCY_SL_CEILING'
  | 'BROKER_REJECT'
  | 'RECONCILIATION_BLOCK';

export type RawTickEvent = {
  timestamp_source: string;
  timestamp_receive: string;
  provider: string;
  instrument: string;
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  sequence_id: number | null;
  source_quality: 'OK' | 'DEGRADED' | 'STALE' | 'ERROR' | 'UNKNOWN';
  latency_ms: number | null;
};

export type FeedValidationReport = {
  instrument: string;
  timestamp: string;
  providers: string[];
  median_mid: number | null;
  max_deviation: number | null;
  dispersion: number | null;
  staleness_ms: number | null;
  latency_ms_max: number | null;
  spread_anomaly: boolean;
  quote_disagreement: boolean;
  missing_providers: string[];
  outlier_score: number | null;
  provenance: string[];
  trading_price: number | null;
  quality: 'OK' | 'DEGRADED' | 'BLOCK' | 'INSUFFICIENT_DATA';
  block: OperationalBlock | null;
  detail: string;
};

export type Candle10s = {
  instrument: string;
  start_ts: string;
  end_ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  tick_count: number;
  bid_open: number;
  bid_high: number;
  bid_low: number;
  bid_close: number;
  ask_open: number;
  ask_high: number;
  ask_low: number;
  ask_close: number;
  spread_min: number;
  spread_max: number;
  spread_mean: number;
  source_count: number;
  quality_score: number;
  provenance: string[];
};

export type MarketStateVector = {
  instrument: string;
  as_of: string;
  /** Measurement layer — null means INSUFFICIENT_DATA for that feature */
  direction_score: number | null;
  trend_strength: number | null;
  trend_quality: number | null;
  volatility_percentile: number | null;
  compression_score: number | null;
  expansion_score: number | null;
  momentum_score: number | null;
  structure_score: number | null;
  breakout_score: number | null;
  reversal_pressure: number | null;
  noise_score: number | null;
  liquidity_score: number | null;
  spread_quality: number | null;
  feed_confidence: number | null;
  /** UI-only interpretation; never used alone to open trades */
  label: string | null;
  inputs: {
    bar_count: number;
    atr: number | null;
    slope: number | null;
    r_squared: number | null;
    hh_hl_lh_ll: string | null;
  };
  status: 'OK' | 'INSUFFICIENT_DATA' | 'FEED_UNAVAILABLE';
};

export type ConditionResult = {
  name: string;
  status: 'PASS' | 'FAIL';
  actual: number | string | boolean | null;
  threshold: number | string | boolean | null;
  detail: string;
};

export type SetupRecord = {
  setup_id: string;
  strategy_id: string;
  instrument: string;
  timestamp: string;
  direction: 'LONG' | 'SHORT' | null;
  conditions: ConditionResult[];
  all_pass: boolean;
  market_state: MarketStateVector;
  feed_quality: FeedValidationReport['quality'];
  entry_reference: number | null;
  invalidation_reference: number | null;
  evidence: string[];
  block: OperationalBlock | null;
};

export type ProtectiveStopPlan = {
  ok: true;
  sl_price: number;
  sl_distance: number;
  sl_method: 'STRUCTURE' | 'ATR' | 'SWING' | 'VOLATILITY_ENVELOPE';
  structure_reference: number | null;
  volatility_reference: number | null;
  calculation_inputs: Record<string, number | string | null>;
  reason: string;
  emergency_ceiling_pct: number;
} | {
  ok: false;
  block: OperationalBlock;
  reason: string;
  calculation_inputs: Record<string, number | string | null>;
};

export type LotPlan = {
  ok: true;
  lot: number;
  method: 'CONFIGURED_LOT' | 'INSTRUMENT_BOUNDS';
  inputs: Record<string, number | string | null>;
} | {
  ok: false;
  reason: string;
  inputs: Record<string, number | string | null>;
};

export type OrderLifecycleState =
  | 'SETUP'
  | 'ENTRY_PENDING'
  | 'SUBMITTED'
  | 'ACKNOWLEDGED'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'PROTECTED'
  | 'MANAGING'
  | 'EXIT_PENDING'
  | 'CLOSED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'ERROR';

export type TradeExplanation = {
  trade_id: string;
  entry: { why: string; calculations: Record<string, unknown> };
  market: MarketStateVector;
  strategy: { id: string; why_selected: string };
  sl: ProtectiveStopPlan;
  lot: LotPlan;
  be_events: Array<{ old_sl: number; new_sl: number; trigger: string; evidence: string; timestamp: string }>;
  tp: { price: number | null; method: string | null; reason: string };
  management: Array<{ decision: string; reason: string; timestamp: string }>;
  exit: { reason: string; timestamp: string | null };
  result: {
    pnl: number | null;
    mfe: number | null;
    mae: number | null;
    peak_captured_pct: number | null;
    giveback: number | null;
    slippage: number | null;
    spread_costs: number | null;
  };
};
