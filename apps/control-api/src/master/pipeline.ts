/** Single authoritative MASTER cycle — one owner per stage. */
import { randomUUID } from 'crypto';
import { analyzeBars } from './analysis.js';
import { decide, setupKey } from './decision.js';
import { ExpectancyStore } from './expectancy.js';
import { MasterJournal } from './journal.js';
import { validateMarket, type MarketValidation } from './marketData.js';
import { evaluateRisk } from './risk.js';
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
};

export type PipelineResult = {
  decision: MasterDecision;
  risk: RiskVerdict;
  opportunity: OpportunityRecord;
  market: MarketValidation;
};

export class MasterPipeline {
  readonly journal = new MasterJournal();
  readonly expectancy = new ExpectancyStore();
  private readonly seenIntents = new Set<string>();

  constructor(public mode: Mode = 'PAPER') {}

  /** MARKET → VALIDATION → ANALYSIS → DECISION → RISK (execution is next step). */
  runCycle(input: PipelineInput): PipelineResult {
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
        () => null
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
      return { decision, risk, opportunity, market };
    }

    const analysis = analyzeBars(market.bars, market.quote.spread, input.now_ms);
    analysis.data_quality = Math.min(analysis.data_quality, market.quality);
    const decision = decide(analysis, market.quote, input.cfg, (k) =>
      this.expectancy.lookup(k)
    );
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
      }
    );
    const opportunity = this.journal.recordOpportunity({
      mode: input.cfg.mode,
      epic: input.instrument.epic,
      decision,
      risk,
      executed: false,
    });
    return { decision, risk, opportunity, market };
  }

  /** Idempotent intent claim — same intent_id cannot execute twice. */
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
    outcome: Parameters<MasterJournal['attachOutcome']>[1]
  ) {
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
  require_positive_expectancy: false, // enable after enough samples
  reward_ratio: 1.8,
  sl_buffer_atr_mult: 0.25,
  kill_switch: false,
  cooldown_ms_after_loss: 30_000,
};

export const GOLD_SPEC: InstrumentSpec = {
  epic: 'GOLD',
  display_name: 'Gold',
  point: 0.01,
  /** Currency PnL per 1.0 point × 1.0 lot */
  value_per_point_per_lot: 1,
  volume_step: 0.01,
  min_volume: 0.01,
  max_volume: 5,
};
