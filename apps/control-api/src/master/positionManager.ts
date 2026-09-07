/**
 * POSITION MANAGER + EXIT — tracks open MASTER positions and applies
 * Best Outcome exit (decideBestOutcomeExit from live desk playbooks).
 */
import { decideBestOutcomeExit, favorableMove } from '../services/exitManage.js';
import type { MasterBroker } from './broker.js';
import type { MasterPipeline } from './pipeline.js';
import type {
  MasterDecision,
  Quote,
  Side,
  TradeOutcome,
} from './types.js';

export type ManagedPosition = {
  position_id: string;
  opportunity_id: string;
  intent_id: string;
  epic: string;
  side: Side;
  size: number;
  entry: number;
  entry_at: string;
  stop_loss: number | null;
  take_profit: number | null;
  mfe: number;
  mae: number;
  decision: MasterDecision;
  regime_at_entry: string;
};

export type ManageTickResult = {
  held: ManagedPosition[];
  closed: Array<{ position: ManagedPosition; outcome: TradeOutcome; reason: string }>;
};

export class PositionManager {
  private open = new Map<string, ManagedPosition>();

  list(): ManagedPosition[] {
    return [...this.open.values()];
  }

  get(position_id: string) {
    return this.open.get(position_id) ?? null;
  }

  count() {
    return this.open.size;
  }

  countForEpic(epic: string) {
    return [...this.open.values()].filter((p) => p.epic === epic).length;
  }

  adopt(pos: ManagedPosition) {
    this.open.set(pos.position_id, pos);
  }

  /** Register after successful fill. */
  register(input: {
    position_id: string;
    opportunity_id: string;
    intent_id: string;
    epic: string;
    side: Side;
    size: number;
    entry: number;
    stop_loss?: number | null;
    take_profit?: number | null;
    decision: MasterDecision;
  }) {
    const pos: ManagedPosition = {
      position_id: input.position_id,
      opportunity_id: input.opportunity_id,
      intent_id: input.intent_id,
      epic: input.epic,
      side: input.side,
      size: input.size,
      entry: input.entry,
      entry_at: new Date().toISOString(),
      stop_loss: input.stop_loss ?? null,
      take_profit: input.take_profit ?? null,
      mfe: 0,
      mae: 0,
      decision: input.decision,
      regime_at_entry: input.decision.analysis.regime,
    };
    this.open.set(pos.position_id, pos);
    return pos;
  }

  /** Update MFE/MAE from mid; decide exits; close via broker. */
  async manageTick(input: {
    broker: MasterBroker;
    pipeline: MasterPipeline;
    quote: Quote;
    instrument_point_value?: number;
  }): Promise<ManageTickResult> {
    const { broker, pipeline, quote } = input;
    const pv = input.instrument_point_value ?? 1;
    const closed: ManageTickResult['closed'] = [];
    const mid = quote.mid;

    for (const pos of [...this.open.values()]) {
      const fav = favorableMove(pos.side, pos.entry, mid);
      pos.mfe = Math.max(pos.mfe, fav);
      pos.mae = Math.max(pos.mae, -fav);
      const peak_retention =
        pos.mfe > 1e-9 ? Math.max(0, Math.min(1, fav / pos.mfe)) : null;

      const verdict = decideBestOutcomeExit(
        {
          open_side: pos.side,
          entry_price: pos.entry,
          entry_at: pos.entry_at,
          mfe: pos.mfe,
          mae: pos.mae,
          peak_retention,
          regime: pos.decision.analysis.regime,
          playbook: mapRegimeToPlaybook(pos.regime_at_entry),
          entry_setup: 'CONTINUATION',
        },
        mid
      );

      if (!verdict.exit) continue;

      const closeRes = await broker.closePosition(pos.position_id);
      if (!closeRes.ok) continue;

      const exit =
        pos.side === 'BUY' ? quote.bid : quote.ask;
      const pnlPts = pos.side === 'BUY' ? exit - pos.entry : pos.entry - exit;
      const pnl = pnlPts * pos.size * pv;
      const riskDist = Math.max(
        Math.abs((pos.stop_loss ?? pos.entry) - pos.entry),
        1e-9
      );
      const outcome: TradeOutcome = {
        position_id: pos.position_id,
        side: pos.side,
        entry: pos.entry,
        exit,
        volume: pos.size,
        pnl,
        fees: 0,
        slippage: Math.abs(exit - mid),
        mae: pos.mae,
        mfe: pos.mfe,
        r_multiple: pnlPts / riskDist,
        hold_ms: Date.now() - new Date(pos.entry_at).getTime(),
        exit_reason: verdict.reason,
      };

      pipeline.recordTradeClose(pos.opportunity_id, pos.decision, outcome);
      this.open.delete(pos.position_id);
      closed.push({ position: pos, outcome, reason: verdict.reason });
    }

    return { held: this.list(), closed };
  }

  /** Sync open set from broker after restart — keep local meta when known. */
  reconcileFromBroker(brokerPositions: Array<{ position_id: string; epic: string; side: Side; size: number; open_level: number }>) {
    const brokerIds = new Set(brokerPositions.map((p) => p.position_id));
    for (const id of [...this.open.keys()]) {
      if (!brokerIds.has(id)) this.open.delete(id);
    }
    for (const bp of brokerPositions) {
      if (this.open.has(bp.position_id)) continue;
      // Orphan broker position — adopt with minimal meta for exit manage
      this.open.set(bp.position_id, {
        position_id: bp.position_id,
        opportunity_id: `recover-${bp.position_id}`,
        intent_id: `recover-${bp.position_id}`,
        epic: bp.epic,
        side: bp.side,
        size: bp.size,
        entry: bp.open_level,
        entry_at: new Date().toISOString(),
        stop_loss: null,
        take_profit: null,
        mfe: 0,
        mae: 0,
        decision: {
          decision_id: `recover-${bp.position_id}`,
          kind: bp.side,
          side: bp.side,
          score: 0,
          block_reason: null,
          buy: null as never,
          sell: null as never,
          analysis: {
            regime: 'UNKNOWN',
            market_state: 'recover',
            momentum_score: 0,
            momentum_dir: 'NEUTRAL',
            trend_dir: 'SIDEWAYS',
            trend_strength: 0,
            structure_bias: 'NEUTRAL',
            swing_high: bp.open_level,
            swing_low: bp.open_level,
            buy_pressure: 0,
            sell_pressure: 0,
            behavior_bull: 0,
            behavior_bear: 0,
            impact_score: 0,
            context_quality: 0,
            volatility: 0,
            atr: 0,
            data_quality: 0.5,
            session: 'UNKNOWN',
          },
          expectancy: null,
        },
        regime_at_entry: 'UNKNOWN',
      });
    }
  }

  /** Serialize for restart recovery. */
  toJSON() {
    return this.list();
  }

  fromJSON(rows: ManagedPosition[]) {
    this.open.clear();
    for (const r of rows) this.open.set(r.position_id, r);
  }
}

function mapRegimeToPlaybook(regime: string): 'LONG' | 'SCALP' | 'FADE' {
  if (regime === 'TREND' || regime === 'BREAKOUT') return 'LONG';
  if (regime === 'RANGE' || regime === 'LOW_VOLATILITY') return 'SCALP';
  return 'SCALP';
}
