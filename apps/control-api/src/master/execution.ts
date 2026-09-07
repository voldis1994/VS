/** EXECUTION stage — place orders only after RISK allows; idempotent by intent_id. */
import type { MasterBroker, PlaceOrderResult } from './broker.js';
import type { MasterPipeline } from './pipeline.js';
import type {
  ExecutionResult,
  MasterDecision,
  OpportunityRecord,
  RiskVerdict,
} from './types.js';

export type ExecuteInput = {
  broker: MasterBroker;
  pipeline: MasterPipeline;
  opportunity: OpportunityRecord;
  decision: MasterDecision;
  risk: RiskVerdict;
  epic: string;
  /** LIVE gate — caller must already enforce MASTER_LIVE_ENABLED for live brokers. */
  allow_live: boolean;
};

export type ExecuteOutput = {
  execution: ExecutionResult;
  place: PlaceOrderResult | null;
};

/**
 * Single entry to broker from MASTER.
 * Blocks: risk denied, WAIT/BLOCK decision, duplicate intent, live without allow_live.
 */
export async function executeDecision(input: ExecuteInput): Promise<ExecuteOutput> {
  const { decision, risk, opportunity, pipeline, broker, epic, allow_live } = input;

  if (decision.kind !== 'BUY' && decision.kind !== 'SELL') {
    const execution: ExecutionResult = {
      intent_id: '',
      order_id: null,
      accepted: false,
      fill_price: null,
      detail: `no_trade_${decision.kind}`,
      paper: broker.paper,
    };
    return { execution, place: null };
  }

  if (!risk.allowed || risk.volume <= 0) {
    const execution: ExecutionResult = {
      intent_id: '',
      order_id: null,
      accepted: false,
      fill_price: null,
      detail: `risk_blocked:${risk.reasons.join(',')}`,
      paper: broker.paper,
    };
    return { execution, place: null };
  }

  if (!broker.paper && !allow_live) {
    const execution: ExecutionResult = {
      intent_id: '',
      order_id: null,
      accepted: false,
      fill_price: null,
      detail: 'live_blocked_MASTER_LIVE_ENABLED',
      paper: false,
    };
    return { execution, place: null };
  }

  const cand = decision.side === 'BUY' ? decision.buy : decision.sell;
  if (!cand || !cand.valid) {
    const execution: ExecutionResult = {
      intent_id: '',
      order_id: null,
      accepted: false,
      fill_price: null,
      detail: 'candidate_invalid',
      paper: broker.paper,
    };
    return { execution, place: null };
  }

  const intent_id = pipeline.newIntentId(decision.decision_id);
  if (!pipeline.claimIntent(intent_id)) {
    const execution: ExecutionResult = {
      intent_id,
      order_id: null,
      accepted: false,
      fill_price: null,
      detail: 'duplicate_intent_pipeline',
      paper: broker.paper,
    };
    return { execution, place: null };
  }

  const place = await broker.placeOrder({
    intent_id,
    epic,
    side: decision.side!,
    size: risk.volume,
    stop_level: cand.stop_loss,
    profit_level: cand.take_profit,
  });

  const execution: ExecutionResult = {
    intent_id,
    order_id: place.order_id,
    accepted: place.ok,
    fill_price: place.fill_price,
    detail: place.detail,
    paper: place.paper,
  };

  pipeline.markExecuted(opportunity.id, execution);
  return { execution, place };
}
