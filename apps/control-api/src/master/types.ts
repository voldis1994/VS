/** VS MASTER — shared types for the single authoritative trading pipeline. */

export type Mode = 'BACKTEST' | 'PAPER' | 'LIVE';
export type Side = 'BUY' | 'SELL';
export type DecisionKind = 'BUY' | 'SELL' | 'WAIT' | 'BLOCK';

export type MarketRegime =
  | 'TREND'
  | 'RANGE'
  | 'BREAKOUT'
  | 'HIGH_VOLATILITY'
  | 'LOW_VOLATILITY'
  | 'UNSTABLE'
  | 'UNKNOWN';

export type Bar = {
  open: number;
  high: number;
  low: number;
  close: number;
  bid?: number;
  ask?: number;
  ts_ms?: number;
};

export type Quote = {
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  ts_ms: number;
};

export type ComponentScores = {
  momentum: number;
  trend: number;
  structure: number;
  pressure: number;
  behavior: number;
  impact: number;
  context: number;
};

export type AnalysisSnapshot = {
  regime: MarketRegime;
  market_state: string;
  momentum_score: number; // -1..+1
  momentum_dir: 'UP' | 'DOWN' | 'NEUTRAL';
  trend_dir: 'UP' | 'DOWN' | 'SIDEWAYS';
  trend_strength: number; // 0..1
  structure_bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  swing_high: number;
  swing_low: number;
  buy_pressure: number;
  sell_pressure: number;
  behavior_bull: number;
  behavior_bear: number;
  impact_score: number;
  context_quality: number;
  volatility: number;
  atr: number;
  data_quality: number;
  session: string;
};

export type TradeCandidate = {
  side: Side;
  valid: boolean;
  /** Heuristic score 0..1 — NOT a calibrated probability */
  score: number;
  components: ComponentScores;
  entry: number;
  stop_loss: number;
  take_profit: number;
  filter_ok: boolean;
  filter_reason: string | null;
};

export type MasterDecision = {
  decision_id: string;
  kind: DecisionKind;
  side: Side | null;
  score: number;
  block_reason: string | null;
  buy: TradeCandidate;
  sell: TradeCandidate;
  analysis: AnalysisSnapshot;
  expectancy: ExpectancySnapshot | null;
};

export type ExpectancySnapshot = {
  setup_key: string;
  samples: number;
  p_win: number;
  avg_win: number;
  avg_loss: number;
  costs: number;
  /** EV = P(win)×AvgWin − P(loss)×AvgLoss − Costs */
  ev: number;
  positive: boolean;
};

export type RiskVerdict = {
  allowed: boolean;
  volume: number;
  risk_amount: number;
  reasons: string[];
};

export type AccountSnapshot = {
  equity: number;
  balance: number;
  currency: string;
  open_positions: number;
  daily_pnl: number;
  peak_equity: number;
  consecutive_losses: number;
};

export type InstrumentSpec = {
  epic: string;
  display_name: string;
  point: number;
  /** Currency PnL per 1.0 point × 1.0 lot */
  value_per_point_per_lot: number;
  volume_step: number;
  min_volume: number;
  max_volume: number;
};

export type OpportunityRecord = {
  id: string;
  ts: string;
  mode: Mode;
  epic: string;
  decision: MasterDecision;
  risk: RiskVerdict;
  executed: boolean;
  execution?: ExecutionResult;
  outcome?: TradeOutcome;
};

export type ExecutionResult = {
  intent_id: string;
  order_id: string | null;
  accepted: boolean;
  fill_price: number | null;
  detail: string;
  paper: boolean;
};

export type TradeOutcome = {
  position_id: string;
  side: Side;
  entry: number;
  exit: number;
  volume: number;
  pnl: number;
  fees: number;
  slippage: number;
  mae: number;
  mfe: number;
  r_multiple: number;
  hold_ms: number;
  exit_reason: string;
};

export type MasterConfig = {
  mode: Mode;
  risk_per_trade_pct: number;
  max_daily_loss_pct: number;
  max_drawdown_pct: number;
  max_open_positions: number;
  max_symbol_positions: number;
  consecutive_loss_limit: number;
  max_spread_abs: number;
  max_spread_pct: number;
  stale_quote_ms: number;
  min_score: number;
  min_expectancy_samples: number;
  require_positive_expectancy: boolean;
  reward_ratio: number;
  sl_buffer_atr_mult: number;
  kill_switch: boolean;
  cooldown_ms_after_loss: number;
  /** AI layer: off | advisory | required (Reader contract) */
  ai_mode: 'off' | 'advisory' | 'required';
};
