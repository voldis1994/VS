/** Single authoritative MASTER cycle — one owner per stage. */
import { randomUUID } from 'crypto';
import { applyAiToDecision, resolveAdvisor, type AiMeta } from './ai.js';
import { analyzeBars } from './analysis.js';
import { decide, setupKey } from './decision.js';
import { ExpectancyStore } from './expectancy.js';
import { MasterJournal } from './journal.js';
import { validateMarket, type MarketValidation } from './marketData.js';
import { evaluateRisk } from './risk.js';
import { DEFAULT_TRADING_HOURS } from './tradingHours.js';
import type {
  AccountSnapshot,
  Bar,
  ExecutionResult,
  InstrumentSpec,
  MasterConfig,
  MasterDecision,
  Mode,
  OpportunityRecord,
  Quote,
  RiskVerdict,
} from './types.js';

export type PipelineInput = {
  bars: Bar[];
  quote: Quote;
  account: AccountSnapshot;
  instrument: InstrumentSpec;
  cfg: MasterConfig;
  symbol_open?: number;
  last_loss_ms?: number;
  now_ms?: number;
  /** Reader relative spread z-score when history available */
  relative_spread?: number | null;
};

export type PipelineResult = {
  decision: MasterDecision;
  risk: RiskVerdict;
  opportunity: OpportunityRecord;
  market: MarketValidation;
  ai: AiMeta;
};

export class MasterPipeline {
  readonly journal = new MasterJournal();
  readonly expectancy = new ExpectancyStore();
  private readonly seenIntents = new Set<string>();

  constructor(public mode: Mode = 'PAPER') {}

  /** MARKET → VALIDATION → ANALYSIS → DECISION → AI → RISK */
  async runCycle(input: PipelineInput): Promise<PipelineResult> {
    const market = validateMarket(input.bars, input.quote, {
      stale_ms: input.cfg.stale_quote_ms,
      max_spread_abs: Math.max(input.cfg.max_spread_abs * 4, 5),
      now_ms: input.now_ms,
    });

    if (!market.ok || !market.quote) {
      const analysis = analyzeBars(
        market.bars.length ? market.bars : input.bars,
        input.quote.spread,
        input.now_ms
      );
      analysis.data_quality = market.quality;
      analysis.market_state = `invalid:${market.reasons.join('|') || 'market'}`;
      const decision = decide(
        analysis,
        input.quote,
        { ...input.cfg, kill_switch: true },
        () => null,
        market.bars.length ? market.bars : input.bars,
        input.relative_spread
      );
      decision.kind = 'BLOCK';
      decision.side = null;
      decision.block_reason = `market_validation:${market.reasons.join(',')}`;
      const risk: RiskVerdict = {
        allowed: false,
        volume: 0,
        risk_amount: 0,
        reasons: ['market_validation', ...market.reasons],
      };
      const opportunity = this.journal.recordOpportunity({
        mode: input.cfg.mode,
        epic: input.instrument.epic,
        decision,
        risk,
        executed: false,
      });
      return {
        decision,
        risk,
        opportunity,
        market,
        ai: {
          ai_mode: input.cfg.ai_mode,
          ai_available: false,
          ai_error_type: null,
          ai_fallback_used: false,
          ai_reason: null,
          allow_close: true,
          system_decision_before_ai: 'BLOCK',
          decision_after_ai: 'BLOCK',
        },
      };
    }

    const analysis = analyzeBars(market.bars, market.quote.spread, input.now_ms);
    analysis.data_quality = Math.min(analysis.data_quality, market.quality);
    let decision = decide(
      analysis,
      market.quote,
      input.cfg,
      (k) => this.expectancy.lookup(k),
      market.bars,
      input.relative_spread
    );

    const mode = input.cfg.ai_mode;
    const resolved = await resolveAdvisor(analysis, mode);
    const applied = applyAiToDecision(decision, mode, resolved.advisor, resolved.error_type);
    decision = applied.decision;
    const aiMeta: AiMeta = applied.meta;

    const risk = evaluateRisk(
      decision,
      input.account,
      input.instrument,
      market.quote,
      input.cfg,
      {
        last_loss_ms: input.last_loss_ms,
        now_ms: input.now_ms,
        symbol_open: input.symbol_open,
        epic: input.instrument.epic,
      }
    );
    const opportunity = this.journal.recordOpportunity({
      mode: input.cfg.mode,
      epic: input.instrument.epic,
      decision,
      risk,
      executed: false,
    });
    return { decision, risk, opportunity, market, ai: aiMeta };
  }

  claimIntent(intent_id: string): boolean {
    if (this.seenIntents.has(intent_id)) return false;
    this.seenIntents.add(intent_id);
    return true;
  }

  markExecuted(opportunityId: string, execution: ExecutionResult) {
    const hit = this.journal.opportunities.find((o) => o.id === opportunityId);
    if (!hit) return;
    hit.executed = execution.accepted;
    hit.execution = execution;
  }

  recordTradeClose(
    opportunityId: string,
    decision: MasterDecision,
    outcome: Parameters<MasterJournal['attachOutcome']>[1],
    meta?: { epic?: string }
  ) {
    // Never silently drop an exit — stub the opportunity row if missing
    const exists = this.journal.opportunities.some((o) => o.id === opportunityId);
    if (!exists) {
      this.journal.recordOpportunity({
        id: opportunityId,
        mode: this.mode,
        epic: meta?.epic || 'UNKNOWN',
        decision,
        risk: {
          allowed: true,
          volume: outcome.volume,
          risk_amount: 0,
          reasons: ['close_stub'],
        },
        executed: true,
        execution: {
          accepted: true,
          intent_id: opportunityId,
          order_id: null,
          fill_price: outcome.entry,
          detail: 'close_stub',
          paper: this.mode === 'PAPER',
        },
      });
    }
    this.journal.attachOutcome(opportunityId, outcome);
    if (decision.side) {
      this.expectancy.record(setupKey(decision.analysis, decision.side), outcome);
    }
  }

  newIntentId(decision_id: string): string {
    return `${decision_id}:${randomUUID()}`;
  }
}

export const DEFAULT_MASTER_CONFIG: MasterConfig = {
  mode: 'PAPER',
  risk_per_trade_pct: 0.01,
  max_daily_loss_pct: 0.03,
  max_drawdown_pct: 0.1,
  max_open_positions: 1,
  max_symbol_positions: 1,
  consecutive_loss_limit: 4,
  max_spread_abs: 1.5,
  max_spread_pct: 0.0004,
  stale_quote_ms: 15_000,
  min_score: 0.55,
  min_expectancy_samples: 20,
  require_positive_expectancy: false,
  reward_ratio: 1.8,
  sl_buffer_atr_mult: 0.25,
  kill_switch: false,
  cooldown_ms_after_loss: 30_000,
  /** ~12×5m Reader-style bars — hard TIME_STOP */
  max_hold_ms: 45 * 60_000,
  breakeven_progress: 0.5,
  ai_mode: 'off',
  block_off_hours: true,
  block_high_impact_news: true,
  volatility_lookback_bars: 14,
  max_relative_volatility: 1.5,
  spread_lookback_bars: 20,
  max_relative_spread: 1.5,
  trailing_buffer_atr_mult: 0.15,
  profit_lock: 0,
  equity_floor: 0,
  daily_loss_limit: 0,
  close_all_profit: 0,
  close_all_loss: 0,
  partial_close_progress: 0.5,
  partial_close_volume: 0.5,
  min_score_delta: 0,
  breakeven_offset: 0,
  trading_hours: { ...DEFAULT_TRADING_HOURS },
  max_stop_loss_pips: 0,
  be_start: 0,
  trail_start: 0,
  trail_lock: 0,
  fixed_lot: 0,
  reduce_lot_after_loss: false,
  reduce_lot_to: 0.01,
  multi_tp_count: 0,
  multi_tp_atr_mult: 1.5,
  breakeven_activation_money: 0,
  soft_trail_money_arm: 0,
  soft_trail_pips: 0.3,
};

export const GOLD_SPEC: InstrumentSpec = {
  epic: 'GOLD',
  display_name: 'Gold',
  point: 0.01,
  value_per_point_per_lot: 1,
  volume_step: 0.01,
  min_volume: 0.01,
  max_volume: 5,
};

/** Resolve InstrumentSpec by epic — GOLD defaults; catalog-backed for other symbols. */
export function specForEpic(epic: string): InstrumentSpec {
  const raw = String(epic || 'GOLD').trim();
  const key = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!key || key === 'GOLD' || key === 'XAUUSD' || key === 'XAU') {
    return { ...GOLD_SPEC, epic: raw || 'GOLD' };
  }
  if (key === 'XAGUSD' || key === 'SILVER' || key === 'XAG') {
    return {
      epic: raw,
      display_name: 'Silver',
      point: 0.001,
      value_per_point_per_lot: 5,
      volume_step: 0.01,
      min_volume: 0.01,
      max_volume: 50,
    };
  }
  if (key.includes('BTC')) {
    return {
      epic: raw,
      display_name: 'Bitcoin',
      point: 0.1,
      value_per_point_per_lot: 1,
      volume_step: 0.01,
      min_volume: 0.01,
      max_volume: 5,
    };
  }
  if (key.includes('ETH')) {
    return {
      epic: raw,
      display_name: 'Ethereum',
      point: 0.01,
      value_per_point_per_lot: 1,
      volume_step: 0.01,
      min_volume: 0.01,
      max_volume: 20,
    };
  }
  if (/US500|SPX|SP500/.test(key)) {
    return {
      epic: raw,
      display_name: 'US500',
      point: 0.1,
      value_per_point_per_lot: 1,
      volume_step: 0.1,
      min_volume: 0.1,
      max_volume: 50,
    };
  }
  if (/US100|UST100|USTECH|NASDAQ|NDX/.test(key)) {
    return {
      epic: raw,
      display_name: 'US100',
      point: 0.1,
      value_per_point_per_lot: 1,
      volume_step: 0.1,
      min_volume: 0.1,
      max_volume: 50,
    };
  }
  if (/US30|DJ30|DOW|DJI/.test(key)) {
    return {
      epic: raw,
      display_name: 'US30',
      point: 1,
      value_per_point_per_lot: 1,
      volume_step: 0.1,
      min_volume: 0.1,
      max_volume: 50,
    };
  }
  if (/GER40|DE40|DAX/.test(key)) {
    return {
      epic: raw,
      display_name: 'GER40',
      point: 0.1,
      value_per_point_per_lot: 1,
      volume_step: 0.1,
      min_volume: 0.1,
      max_volume: 50,
    };
  }
  if (/UK100|FTSE/.test(key)) {
    return {
      epic: raw,
      display_name: 'UK100',
      point: 0.1,
      value_per_point_per_lot: 1,
      volume_step: 0.1,
      min_volume: 0.1,
      max_volume: 50,
    };
  }
  if (/EURUSD|GBPUSD|USDJPY|AUDUSD|USDCAD|USDCHF|NZDUSD|EURGBP|EURJPY|GBPJPY/.test(key)) {
    const jpy = key.includes('JPY');
    return {
      epic: raw,
      display_name: raw,
      point: jpy ? 0.001 : 0.00001,
      value_per_point_per_lot: jpy ? 1 : 10_000,
      volume_step: 0.01,
      min_volume: 0.01,
      max_volume: 100,
    };
  }
  if (/USOIL|UKOIL|OIL|WTI|BRENT/.test(key)) {
    return {
      epic: raw,
      display_name: 'Oil',
      point: 0.01,
      value_per_point_per_lot: 10,
      volume_step: 0.01,
      min_volume: 0.01,
      max_volume: 50,
    };
  }
  // Conservative default — tick size from catalog when known
  return {
    epic: raw,
    display_name: raw,
    point: 0.01,
    value_per_point_per_lot: 1,
    volume_step: 0.01,
    min_volume: 0.01,
    max_volume: 20,
  };
}
