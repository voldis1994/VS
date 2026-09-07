/**
 * POSITION MANAGER + EXIT — tracks open MASTER positions and applies
 * Best Outcome exit (decideBestOutcomeExit from live desk playbooks).
 */
import { createHash } from 'crypto';
import { decideBestOutcomeExit, favorableMove } from '../services/exitManage.js';
import type { MasterBroker } from './broker.js';
import type { MasterPipeline } from './pipeline.js';
import type {
  MasterDecision,
  Quote,
  Side,
  TradeOutcome,
} from './types.js';

/** Deterministic UUID for broker-orphan recovery — Postgres id columns require UUID. */
export function stableRecoverUuid(positionId: string): string {
  const h = createHash('sha256').update(`vs-master-recover:${positionId}`).digest();
  const bytes = Buffer.from(h.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

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

  /** Update MFE/MAE from mid; time-stop; trail/BE SL; decide exits; close via broker. */
  async manageTick(input: {
    broker: MasterBroker;
    pipeline: MasterPipeline;
    quote: Quote;
    instrument_point_value?: number;
    max_hold_ms?: number;
    breakeven_progress?: number;
  }): Promise<ManageTickResult> {
    const { broker, pipeline, quote } = input;
    const pv = input.instrument_point_value ?? 1;
    const maxHold = input.max_hold_ms ?? 0;
    const beProgress = input.breakeven_progress ?? 0.5;
    const closed: ManageTickResult['closed'] = [];
    const mid = quote.mid;

    for (const pos of [...this.open.values()]) {
      const fav = favorableMove(pos.side, pos.entry, mid);
      pos.mfe = Math.max(pos.mfe, fav);
      pos.mae = Math.max(pos.mae, -fav);
      const peak_retention =
        pos.mfe > 1e-9 ? Math.max(0, Math.min(1, fav / pos.mfe)) : null;
      const heldMs = Date.now() - new Date(pos.entry_at).getTime();

      // Hard protective fills before soft BestOutcome / TIME_STOP
      const protective = protectiveExit(pos, mid);

      let verdict =
        protective ??
        (maxHold > 0 && heldMs >= maxHold
          ? {
              exit: true,
              reason: `TIME_STOP · held ${Math.round(heldMs / 1000)}s ≥ ${Math.round(maxHold / 1000)}s`,
            }
          : decideBestOutcomeExit(
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
            ));

      if (!verdict.exit) {
        await this.maybeBreakevenStop(broker, pos, mid, beProgress);
        await this.maybeTrailStop(broker, pos, mid);
        continue;
      }

      const closeRes = await broker.closePosition(pos.position_id);
      if (!closeRes.ok) continue;

      const exit = protectiveFillPrice(pos, quote, protective?.reason ?? null);
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
        hold_ms: heldMs,
        exit_reason: verdict.reason,
      };

      pipeline.recordTradeClose(pos.opportunity_id, pos.decision, outcome, {
        epic: pos.epic,
      });
      this.open.delete(pos.position_id);
      closed.push({ position: pos, outcome, reason: verdict.reason });
    }

    return { held: this.list(), closed };
  }

  /**
   * Reader-style breakeven: once progress toward TP clears threshold, move SL to entry.
   * Only tightens; never loosens.
   */
  private async maybeBreakevenStop(
    broker: MasterBroker,
    pos: ManagedPosition,
    mid: number,
    progressNeed: number
  ): Promise<void> {
    if (!broker.modifyPosition || progressNeed <= 0) return;
    if (pos.take_profit == null) return;
    const tpDist = Math.abs(pos.take_profit - pos.entry);
    if (tpDist < 1e-9) return;
    const fav = favorableMove(pos.side, pos.entry, mid);
    if (fav / tpDist < progressNeed) return;
    const be = pos.entry;
    const cur = pos.stop_loss;
    const tighter =
      cur == null
        ? true
        : pos.side === 'BUY'
          ? be > cur
          : be < cur;
    if (!tighter) return;
    if (pos.side === 'BUY' && be >= mid) return;
    if (pos.side === 'SELL' && be <= mid) return;
    const mod = await broker.modifyPosition({
      position_id: pos.position_id,
      stop_level: be,
    });
    if (mod.ok) pos.stop_loss = be;
  }

  /**
   * Ratchet broker SL once MFE clears a floor — lock ~50% of peak favorable move.
   * Only tightens; never loosens. Requires broker.modifyPosition.
   */
  private async maybeTrailStop(
    broker: MasterBroker,
    pos: ManagedPosition,
    mid: number
  ): Promise<void> {
    if (!broker.modifyPosition) return;
    const absEntry = Math.max(Math.abs(pos.entry), 1e-9);
    const mfeFloor = Math.max(absEntry * 0.00025, 0.8);
    if (pos.mfe < mfeFloor) return;
    const lock = pos.mfe * 0.5;
    const trailed =
      pos.side === 'BUY' ? pos.entry + lock : pos.entry - lock;
    const cur = pos.stop_loss;
    const tighter =
      cur == null
        ? true
        : pos.side === 'BUY'
          ? trailed > cur
          : trailed < cur;
    if (!tighter) return;
    // Don't trail through current mid (would instant-stop)
    if (pos.side === 'BUY' && trailed >= mid) return;
    if (pos.side === 'SELL' && trailed <= mid) return;
    const mod = await broker.modifyPosition({
      position_id: pos.position_id,
      stop_level: trailed,
    });
    if (mod.ok) pos.stop_loss = trailed;
  }

  /** Sync open set from broker after restart — keep local meta when known. */
  reconcileFromBroker(
    brokerPositions: Array<{
      position_id: string;
      epic: string;
      side: Side;
      size: number;
      open_level: number;
      stop_level?: number | null;
      profit_level?: number | null;
      opened_at?: string | null;
    }>
  ) {
    const brokerIds = new Set(brokerPositions.map((p) => p.position_id));
    for (const id of [...this.open.keys()]) {
      if (!brokerIds.has(id)) this.open.delete(id);
    }
    for (const bp of brokerPositions) {
      const existing = this.open.get(bp.position_id);
      if (existing) {
        // Refresh protective levels from broker truth when present
        if (bp.stop_level != null) existing.stop_loss = bp.stop_level;
        if (bp.profit_level != null) existing.take_profit = bp.profit_level;
        if (bp.size > 0) existing.size = bp.size;
        continue;
      }
      // Orphan broker position — adopt broker SL/TP + open time when available
      const recoverId = stableRecoverUuid(bp.position_id);
      const entryAt =
        bp.opened_at && Number.isFinite(Date.parse(bp.opened_at))
          ? new Date(bp.opened_at).toISOString()
          : new Date().toISOString();
      this.open.set(bp.position_id, {
        position_id: bp.position_id,
        opportunity_id: recoverId,
        intent_id: recoverId,
        epic: bp.epic,
        side: bp.side,
        size: bp.size,
        entry: bp.open_level,
        entry_at: entryAt,
        stop_loss: bp.stop_level ?? null,
        take_profit: bp.profit_level ?? null,
        mfe: 0,
        mae: 0,
        decision: {
          decision_id: recoverId,
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

/** Price-cross SL/TP — returns exit verdict or null when levels not breached. */
export function protectiveExit(
  pos: Pick<ManagedPosition, 'side' | 'stop_loss' | 'take_profit'>,
  mid: number
): { exit: true; reason: string } | null {
  if (pos.stop_loss != null) {
    const hit = pos.side === 'BUY' ? mid <= pos.stop_loss : mid >= pos.stop_loss;
    if (hit) return { exit: true, reason: 'STOP_HIT' };
  }
  if (pos.take_profit != null) {
    const hit = pos.side === 'BUY' ? mid >= pos.take_profit : mid <= pos.take_profit;
    if (hit) return { exit: true, reason: 'TP_HIT' };
  }
  return null;
}

function protectiveFillPrice(
  pos: ManagedPosition,
  quote: Quote,
  reason: string | null
): number {
  if (reason === 'STOP_HIT' && pos.stop_loss != null) return pos.stop_loss;
  if (reason === 'TP_HIT' && pos.take_profit != null) return pos.take_profit;
  return pos.side === 'BUY' ? quote.bid : quote.ask;
}
