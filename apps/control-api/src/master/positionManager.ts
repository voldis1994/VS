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
  /** Reader-style: one scale-out already taken */
  partial_close_applied?: boolean;
};

export type ManageTickResult = {
  held: ManagedPosition[];
  closed: Array<{ position: ManagedPosition; outcome: TradeOutcome; reason: string }>;
  /** Exit verdict fired but broker.closePosition failed — do not journal as closed */
  close_failed: Array<{ position_id: string; exit_reason: string; detail: string }>;
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
      partial_close_applied: false,
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
    partial_close_progress?: number;
    partial_close_volume?: number;
    volume_step?: number;
    /** Structure swings for Reader trailing (from live analysis) */
    swing_low?: number | null;
    swing_high?: number | null;
    trailing_buffer?: number;
  }): Promise<ManageTickResult> {
    const { broker, pipeline, quote } = input;
    const pv = input.instrument_point_value ?? 1;
    const maxHold = input.max_hold_ms ?? 0;
    const beProgress = input.breakeven_progress ?? 0.5;
    const partialProgress = input.partial_close_progress ?? 0;
    const partialVolume = input.partial_close_volume ?? 0;
    const volumeStep = input.volume_step ?? 0.01;
    const swingLow = input.swing_low ?? null;
    const swingHigh = input.swing_high ?? null;
    const trailBuf = input.trailing_buffer ?? 0;
    const closed: ManageTickResult['closed'] = [];
    const close_failed: ManageTickResult['close_failed'] = [];

    for (const pos of [...this.open.values()]) {
      const mark = protectiveMark(pos.side, quote);
      const fav = favorableMove(pos.side, pos.entry, mark);
      pos.mfe = Math.max(pos.mfe, fav);
      pos.mae = Math.max(pos.mae, -fav);
      const peak_retention =
        pos.mfe > 1e-9 ? Math.max(0, Math.min(1, fav / pos.mfe)) : null;
      const heldMs = Date.now() - new Date(pos.entry_at).getTime();

      // Reader partial scale-out before full exit (once)
      // Skip when broker cannot partial (Check- MT4 full-lots CLOSE only)
      if (
        broker.supportsPartialClose !== false &&
        !pos.partial_close_applied &&
        partialProgress > 0 &&
        partialVolume > 0 &&
        pos.take_profit != null
      ) {
        const partial = evaluatePartialClose(pos, mark, {
          progressNeed: partialProgress,
          volumeRatio: partialVolume,
          volumeStep,
        });
        if (partial) {
          const closeRes = await broker.closePosition(pos.position_id, {
            size: partial.close_size,
          });
          if (closeRes.ok) {
            const fill =
              closeRes.fill_price != null && Number.isFinite(closeRes.fill_price)
                ? Number(closeRes.fill_price)
                : mark;
            const pnlPts = pos.side === 'BUY' ? fill - pos.entry : pos.entry - fill;
            const pnl = pnlPts * partial.close_size * pv;
            const outcome: TradeOutcome = {
              position_id: pos.position_id,
              side: pos.side,
              entry: pos.entry,
              exit: fill,
              volume: partial.close_size,
              pnl,
              fees: 0,
              slippage: Math.abs(fill - quote.mid),
              mae: pos.mae,
              mfe: pos.mfe,
              r_multiple: 0,
              hold_ms: heldMs,
              exit_reason: partial.reason,
            };
            pipeline.recordTradeClose(pos.opportunity_id, pos.decision, outcome, {
              epic: pos.epic,
            });
            const rem =
              closeRes.remaining_size != null && Number.isFinite(closeRes.remaining_size)
                ? Number(closeRes.remaining_size)
                : Math.max(0, pos.size - partial.close_size);
            if (rem > 1e-9) {
              pos.size = rem;
              pos.partial_close_applied = true;
              closed.push({ position: { ...pos }, outcome, reason: partial.reason });
              continue;
            }
            this.open.delete(pos.position_id);
            closed.push({ position: pos, outcome, reason: partial.reason });
            continue;
          }
          // Partial failed — fall through to full manage (do not mark applied)
        }
      }

      // Hard protective fills before soft BestOutcome / TIME_STOP
      const protective = protectiveExit(pos, quote);

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
              mark
            ));

      if (!verdict.exit) {
        await this.maybeBreakevenStop(broker, pos, quote, beProgress);
        await this.maybeTrailStop(broker, pos, quote, {
          swing_low: swingLow,
          swing_high: swingHigh,
          trailing_buffer: trailBuf,
        });
        continue;
      }

      const closeRes = await broker.closePosition(pos.position_id);
      if (!closeRes.ok) {
        close_failed.push({
          position_id: pos.position_id,
          exit_reason: verdict.reason,
          detail: closeRes.detail || 'close_failed',
        });
        continue;
      }

      const brokerFill =
        closeRes.fill_price != null && Number.isFinite(closeRes.fill_price)
          ? Number(closeRes.fill_price)
          : null;
      const exit =
        brokerFill ??
        protectiveFillPrice(pos, quote, protective?.reason ?? null);
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
        slippage: Math.abs(exit - quote.mid),
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

    return { held: this.list(), closed, close_failed };
  }

  /**
   * Reader-style breakeven: once progress toward TP clears threshold, move SL to entry.
   * Only tightens; never loosens.
   */
  private async maybeBreakevenStop(
    broker: MasterBroker,
    pos: ManagedPosition,
    quote: Quote,
    progressNeed: number
  ): Promise<void> {
    if (!broker.modifyPosition || progressNeed <= 0) return;
    if (pos.take_profit == null) return;
    const tpDist = Math.abs(pos.take_profit - pos.entry);
    if (tpDist < 1e-9) return;
    const mark = protectiveMark(pos.side, quote);
    const fav = favorableMove(pos.side, pos.entry, mark);
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
    if (pos.side === 'BUY' && be >= mark) return;
    if (pos.side === 'SELL' && be <= mark) return;
    const mod = await broker.modifyPosition({
      position_id: pos.position_id,
      stop_level: be,
    });
    if (mod.ok) pos.stop_loss = be;
  }

  /**
   * Trail SL — prefer Reader structure swings (swing ± buffer), else MFE 50% ratchet.
   * Only tightens; never loosens. Requires broker.modifyPosition.
   */
  private async maybeTrailStop(
    broker: MasterBroker,
    pos: ManagedPosition,
    quote: Quote,
    structure?: {
      swing_low?: number | null;
      swing_high?: number | null;
      trailing_buffer?: number;
    }
  ): Promise<void> {
    if (!broker.modifyPosition) return;
    const mark = protectiveMark(pos.side, quote);
    const buf = structure?.trailing_buffer ?? 0;
    let trailed: number | null = null;

    if (pos.side === 'BUY') {
      const swing = structure?.swing_low;
      if (swing != null && Number.isFinite(swing) && swing > 0 && buf >= 0) {
        const cand = swing - buf;
        if (cand < mark && (pos.stop_loss == null || cand > pos.stop_loss)) {
          trailed = cand;
        }
      }
    } else {
      const swing = structure?.swing_high;
      if (swing != null && Number.isFinite(swing) && swing > 0 && buf >= 0) {
        const cand = swing + buf;
        if (cand > mark && (pos.stop_loss == null || cand < pos.stop_loss)) {
          trailed = cand;
        }
      }
    }

    // MFE ratchet only when structure did not produce a trail (Reader swing is primary)
    if (trailed == null) {
      const absEntry = Math.max(Math.abs(pos.entry), 1e-9);
      const mfeFloor = Math.max(absEntry * 0.00025, 0.8);
      if (pos.mfe >= mfeFloor) {
        const lock = pos.mfe * 0.5;
        const mfeTrail = pos.side === 'BUY' ? pos.entry + lock : pos.entry - lock;
        const mfeOk = pos.side === 'BUY' ? mfeTrail < mark : mfeTrail > mark;
        const tighterThanCur =
          pos.stop_loss == null
            ? true
            : pos.side === 'BUY'
              ? mfeTrail > pos.stop_loss
              : mfeTrail < pos.stop_loss;
        if (mfeOk && tighterThanCur) trailed = mfeTrail;
      }
    }

    if (trailed == null) return;
    const cur = pos.stop_loss;
    const tighter =
      cur == null
        ? true
        : pos.side === 'BUY'
          ? trailed > cur
          : trailed < cur;
    if (!tighter) return;
    if (pos.side === 'BUY' && trailed >= mark) return;
    if (pos.side === 'SELL' && trailed <= mark) return;
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

/** Reader-style partial close when progress toward TP clears threshold. */
export function evaluatePartialClose(
  pos: Pick<ManagedPosition, 'side' | 'entry' | 'take_profit' | 'size' | 'partial_close_applied'>,
  mark: number,
  cfg: { progressNeed: number; volumeRatio: number; volumeStep: number }
): { close_size: number; reason: string } | null {
  if (pos.partial_close_applied) return null;
  if (pos.take_profit == null) return null;
  if (cfg.progressNeed <= 0 || cfg.volumeRatio <= 0 || cfg.volumeStep <= 0) return null;
  const tpDist = Math.abs(pos.take_profit - pos.entry);
  if (tpDist < 1e-9) return null;
  const fav = favorableMove(pos.side, pos.entry, mark);
  const progress = fav / tpDist;
  if (progress < cfg.progressNeed) return null;
  const raw = pos.size * cfg.volumeRatio;
  const steps = Math.floor(raw / cfg.volumeStep + 1e-12);
  const close_size = steps * cfg.volumeStep;
  if (close_size <= 0 || close_size >= pos.size - 1e-12) return null;
  return {
    close_size,
    reason: `PARTIAL_CLOSE · ${(cfg.volumeRatio * 100).toFixed(0)}% @ ${(progress * 100).toFixed(0)}% to TP`,
  };
}

/** Price used to detect SL/TP hits — BUY exits on bid, SELL on ask. */
export function protectiveMark(
  side: Side,
  quote: Pick<Quote, 'bid' | 'ask' | 'mid'>
): number {
  if (side === 'BUY') return quote.bid;
  if (side === 'SELL') return quote.ask;
  return quote.mid;
}

/**
 * Shift planned SL/TP by fill−plannedEntry so risk geometry matches real fill
 * (ask/bid fill vs mid-planned, plus slippage).
 */
export function rebaseStopsFromFill(
  plannedEntry: number,
  fill: number,
  stop: number | null,
  tp: number | null
): { stop_loss: number | null; take_profit: number | null } {
  if (!Number.isFinite(plannedEntry) || !Number.isFinite(fill)) {
    return { stop_loss: stop, take_profit: tp };
  }
  const d = fill - plannedEntry;
  if (Math.abs(d) < 1e-12) return { stop_loss: stop, take_profit: tp };
  return {
    stop_loss: stop != null ? stop + d : null,
    take_profit: tp != null ? tp + d : null,
  };
}

/** Price-cross SL/TP — returns exit verdict or null when levels not breached. */
export function protectiveExit(
  pos: Pick<ManagedPosition, 'side' | 'stop_loss' | 'take_profit'>,
  quote: Pick<Quote, 'bid' | 'ask' | 'mid'>
): { exit: true; reason: string } | null {
  const mark = protectiveMark(pos.side, quote);
  if (pos.stop_loss != null) {
    const hit = pos.side === 'BUY' ? mark <= pos.stop_loss : mark >= pos.stop_loss;
    if (hit) return { exit: true, reason: 'STOP_HIT' };
  }
  if (pos.take_profit != null) {
    const hit = pos.side === 'BUY' ? mark >= pos.take_profit : mark <= pos.take_profit;
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
  return protectiveMark(pos.side, quote);
}
