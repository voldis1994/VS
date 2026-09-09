/** VS MASTER — shared types for the single authoritative trading pipeline. */

export type Mode = 'BACKTEST' | 'PAPER' | 'LIVE';
export type Side = 'BUY' | 'SELL';
export type DecisionKind = 'BUY' | 'SELL' | 'WAIT' | 'BLOCK';

export type MarketRegime =
  | 'TREND'
  | 'TREND_UP'
  | 'TREND_DOWN'
  | 'RANGE'
  | 'BREAKOUT'
  | 'BREAKOUT_UP'
  | 'BREAKOUT_DOWN'
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
  /** Optional epic for news calendar / broker routing */
  epic?: string;
  /** Optional live Capital min-stop distance from dealingRules */
  min_stop_distance?: number | null;
  /** Optional Capital marketStatus (TRADEABLE/OPEN/…) */
  market_status?: string | null;
  /** Optional MT4 Digits from market/latest.json */
  digits?: number | null;
  /** Optional MT4 Point from market/latest.json */
  point?: number | null;
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
  /** Desk 10s confirm path that drove this decide (EV setupKey dimension). */
  desk_entry_source?: 'setup' | 'move' | 'none' | null;
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
  /** Realized PnL for daily_pnl_day only — rolled at UTC midnight */
  daily_pnl: number;
  /** UTC YYYY-MM-DD that daily_pnl accrues under */
  daily_pnl_day?: string | null;
  /**
   * Equity at start of daily_pnl_day — denom for max_daily_loss and Check
   * equity-delta hard $ gates (profit_lock / daily_loss_limit use equity − this).
   */
  day_start_equity?: number | null;
  peak_equity: number;
  consecutive_losses: number;
  /** Free margin / available to deal when broker provides it */
  available_to_deal?: number | null;
  /**
   * Broker trade permission (MT4 IsTradeAllowed / Reader trade_allowed).
   * undefined = unknown (do not block); false = hard block entries.
   */
  trade_allowed?: boolean | null;
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
  /** Durable EV setupKey from last close (desk-source suffix for Confirm PnL). */
  setup_key?: string | null;
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
  /**
   * Capital LIVE: false when realized money was not venue-proven (no confirm
   * profit / usable UPL). Callers must not update daily_pnl / loss streak.
   * Omit/undefined = proven (paper mark path and broker-confirmed closes).
   */
  pnl_proven?: boolean;
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
  /** Hard max hold wall-clock — used only when time_stop_max_bars is 0 */
  max_hold_ms: number;
  /**
   * Reader time_stop_max_bars — manage cycles since entry before TIME_STOP.
   * When >0, bars_open wins (restart/overnight must not instant-exit via wall clock).
   * 0 falls back to max_hold_ms.
   */
  time_stop_max_bars: number;
  /** Progress toward TP (0..1) before moving SL to breakeven */
  breakeven_progress: number;
  /** AI layer: off | advisory | required (Reader contract) */
  ai_mode: 'off' | 'advisory' | 'required';
  /** Reader OFF session — block new entries outside ASIA/LONDON/NY windows */
  block_off_hours: boolean;
  /** Reader high-impact news window — block new entries (exits still manage) */
  block_high_impact_news: boolean;
  /** Reader relative volatility: current TR / mean TR lookback */
  volatility_lookback_bars: number;
  /** Block when relative volatility exceeds this (Reader default ~1.5) */
  max_relative_volatility: number;
  /** Reader relative spread lookback */
  spread_lookback_bars: number;
  /** Block when relative spread z-score exceeds this (Reader default ~1.5) */
  max_relative_spread: number;
  /** Reader trail buffer as ATR multiple off structure swings */
  trailing_buffer_atr_mult: number;
  /**
   * Check- profit lock (account currency). >0 blocks new entries once daily_pnl ≥ lock.
   * 0 = disabled.
   */
  profit_lock: number;
  /**
   * Check- equity floor. >0 blocks new entries when equity ≤ floor.
   * 0 = disabled.
   */
  equity_floor: number;
  /**
   * Check- hard $ daily loss. >0 blocks when daily_pnl ≤ -limit.
   * 0 = disabled (percent max_daily_loss_pct still applies).
   */
  daily_loss_limit: number;
  /**
   * Check- close-all when floating PnL ≥ this (account currency). 0 = disabled.
   */
  close_all_profit: number;
  /**
   * Check- close-all when floating PnL ≤ -this. 0 = disabled.
   */
  close_all_loss: number;
  /** Reader partial close: progress toward TP (0..1) before scaling out */
  partial_close_progress: number;
  /** Fraction of size to close on first scale-out (0..1) */
  partial_close_volume: number;
  /**
   * Reader near-tie: when both sides valid and |buy−sell| < delta → WAIT.
   * 0 = only exact equality (equal_scores).
   */
  min_score_delta: number;
  /** Check- BE offset past entry (price units). 0 = lock exactly at entry. */
  breakeven_offset: number;
  /** Check- optional hard trading-hours window */
  trading_hours: import('./tradingHours.js').TradingHoursConfig;
  /**
   * Reader max SL distance in pips (instrument.point). 0 = disabled.
   * When >0, oversized structure stops are rejected before ALLOW.
   */
  max_stop_loss_pips: number;
  /**
   * Check- BE arm distance in price units (favorable move). 0 = use progress-to-TP only.
   * When >0, BE can arm without a take_profit (orphan recover).
   */
  be_start: number;
  /** Check- trail arm distance in price units. 0 = structure/MFE trail only. */
  trail_start: number;
  /** Check- trail lock distance from mark once armed. Requires trail_start > 0. */
  trail_lock: number;
  /** Check- fixed lot. 0 = equity % sizing. */
  fixed_lot: number;
  /** Check- after a loss, next size uses reduce_lot_to instead of equity/fixed. */
  reduce_lot_after_loss: boolean;
  /** Lot used when reduce_lot_after_loss is active. */
  reduce_lot_to: number;
  /**
   * VS-System multi-TP ladder count. 0 = off (single Reader partial).
   * ≥2 builds equal ATR-spaced levels; native TP = final level.
   */
  multi_tp_count: number;
  /** Final TP distance = ATR × this when multi_tp_count ≥ 2. */
  multi_tp_atr_mult: number;
  /**
   * VS-System money BE arm (account currency). >0 arms BE on floating £/$ PnL.
   * 0 = disabled (price/progress paths only).
   */
  breakeven_activation_money: number;
  /**
   * Soft-trail money arm (account currency). >0 enables software peak trail exit.
   * 0 = off.
   */
  soft_trail_money_arm: number;
  /** Soft-trail pullback distance in pips once armed (VS-System default 0.3). */
  soft_trail_pips: number;
  /**
   * VS-System 10%/20% broker SL chase (SCALP_INITIAL_SL_PCT / SCALP_LOCK_PCT).
   * Soft trail alone is software-only — enable this for Capital/MT4 stopLevel chase.
   */
  scalp_pct_chase: boolean;
  /** Lock fraction of favorable move left as cushion (default 0.2 = 20%). */
  scalp_lock_pct: number;
  /**
   * VS-System strict candle-bias entry gate (falling-knife / weak-edge kill).
   * Scores are 0..1 — use scalp_min_edge accordingly.
   */
  scalp_strict_entry: boolean;
  /** Min |buy−sell| score edge for scalp_strict_entry (default 0.12). */
  scalp_min_edge: number;
  /**
   * VS-System EMA_TICK fresh-cross entry gate (struct/closed EMA1×EMA3 + divergence).
   * Soft scores alone cannot open while waiting for a fresh cross.
   */
  ema_tick_entry: boolean;
  /**
   * VS-System post-CLOSE skip (ms) — no same-tick / immediate re-entry after exit.
   * Default 900 matches opposite-close settle in strategy-runtime.
   */
  post_exit_cooldown_ms: number;
  /**
   * Reader cycle_max_duration_ms — skip new OPEN when the cycle already exceeded this.
   * Does not abort an in-flight placeOrder (double-open risk).
   */
  cycle_max_duration_ms: number;
  /**
   * Desk SETUP-first entry: BUY/SELL only when sticky setup is ARMED and side matches.
   * LIVE Capital path enables this by default; PAPER demos keep false.
   */
  require_armed_setup: boolean;
};
