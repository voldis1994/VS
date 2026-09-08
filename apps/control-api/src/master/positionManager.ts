/**
 * POSITION MANAGER + EXIT — tracks open MASTER positions and applies
 * Best Outcome exit (decideBestOutcomeExit from live desk playbooks).
 */
import { createHash } from 'crypto';
import { decideBestOutcomeExit, favorableMove } from '../services/exitManage.js';
import type { MasterBroker } from './broker.js';
import { clampStopForCapitalMark, effectiveMinStopDistance } from './capitalStop.js';
import {
  clampCloseVolume,
  multiTpFinalPrice,
  multiTpHit,
  multiTpPendingIndex,
  type MultiTpLevel,
} from './multiTp.js';
import {
  capitalSafeBreakEvenStop,
  decideSoftTrailArm,
  resolveCloseMoneyPnl,
  resolveFloatingMoneyPnl,
  softTrailDistancePrice,
  softTrailExitHit,
  softTrailExitLevel,
  updateSoftTrailPeak,
} from './moneyExit.js';
import { closeAllowedByStopLoss } from './closeRequiresSl.js';
import type { MasterPipeline } from './pipeline.js';
import {
  SCALP_LOCK_PCT,
  SCALP_SL_CHASE_MIN_INTERVAL_MS,
  scalpChaseIsImprovement,
  scalpInitialBrokerStop,
  scalpInitialStopDistance,
  scalpPctLockBrokerStop,
} from './scalpPctChase.js';
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
  /** Reader-style: one scale-out already taken (or external shrink) */
  partial_close_applied?: boolean;
  /** VS-System multi-TP ladder (app-managed intermediates) */
  multi_tp_levels?: MultiTpLevel[];
  /** Soft-trail armed timestamp (ISO) once money arm clears */
  soft_trail_armed_at?: string | null;
  /** Soft-trail peak mark watermark */
  soft_trail_peak?: number | null;
  /** VS-System: Capital native trailingStop already armed */
  native_trail_armed?: boolean;
  /** Last broker-reported UPL (account currency) when known */
  broker_upl?: number | null;
};

export type ManageTickResult = {
  held: ManagedPosition[];
  closed: Array<{ position: ManagedPosition; outcome: TradeOutcome; reason: string }>;
  /** Exit verdict fired but broker.closePosition failed — do not journal as closed */
  close_failed: Array<{ position_id: string; exit_reason: string; detail: string }>;
};

/** Reader EXTERNAL_PARTIAL_CLOSE — closed slice detected via broker size shrink. */
export type ExternalPartialEvent = {
  position_id: string;
  opportunity_id: string;
  intent_id: string;
  epic: string;
  side: Side;
  entry: number;
  closed_size: number;
  remaining_size: number;
  mark_proxy: number;
  decision: MasterDecision;
  mae: number;
  mfe: number;
  /** Scaled slice of last-known broker UPL for honest journal PnL */
  broker_upl_closed?: number | null;
};

export class PositionManager {
  private open = new Map<string, ManagedPosition>();
  /** VS-System: skip resending the same rejected trail/BE level until backoff expires */
  private modifyBackoff = new Map<string, { until: number; level: number }>();
  /** VS-System scalp chase rate-limit (last successful/attempted improve ms) */
  private scalpChaseAt = new Map<string, number>();
  /** VS-System naked SL recovery throttle */
  private nakedRecoveryAt = new Map<string, number>();
  /** VS-System escalate distance on reject: multipliers [1,2,3,5] */
  private nakedRecoveryLevel = new Map<string, number>();
  private static readonly NAKED_RECOVERY_MS = 8_000;
  private static readonly NAKED_RECOVERY_MULTS = [1, 2, 3, 5] as const;

  list(): ManagedPosition[] {
    return [...this.open.values()];
  }

  get(position_id: string) {
    return this.open.get(position_id) ?? null;
  }

  /** Operator / manual close — remove from local book after broker close succeeds. */
  drop(position_id: string): boolean {
    return this.open.delete(position_id);
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
    multi_tp_levels?: MultiTpLevel[];
  }) {
    let take_profit = input.take_profit ?? null;
    const levels = input.multi_tp_levels?.length
      ? input.multi_tp_levels.map((l) => ({ ...l }))
      : undefined;
    if (levels?.length) {
      const final = multiTpFinalPrice(levels);
      if (final != null) take_profit = final;
    }
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
      take_profit,
      mfe: 0,
      mae: 0,
      decision: input.decision,
      regime_at_entry: input.decision.analysis.regime,
      partial_close_applied: false,
      multi_tp_levels: levels,
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
    /** Check- lock past entry by this many price units */
    breakeven_offset?: number;
    /** Check- BE arm in price units (0 = progress-to-TP path) */
    be_start?: number;
    /** Check- trail arm / lock in price units (0 = structure/MFE only) */
    trail_start?: number;
    trail_lock?: number;
    partial_close_progress?: number;
    partial_close_volume?: number;
    volume_step?: number;
    /** Structure swings for Reader trailing (from live analysis) */
    swing_low?: number | null;
    swing_high?: number | null;
    trailing_buffer?: number;
    /**
     * Reader AI allow_close — soft exits (TIME_STOP / BestOutcome / partial) vetoed when false.
     * Hard STOP_HIT / TP_HIT always close. Default true.
     */
    allow_close?: boolean;
    /** Check- portfolio close-all thresholds (0 = off) */
    close_all_profit?: number;
    close_all_loss?: number;
    /** Live Capital min-stop distance (dealingRules) when known */
    min_stop_distance?: number | null;
    /** VS-System money BE arm (£/$). 0 = off */
    breakeven_activation_money?: number;
    /** Soft-trail money arm (£/$). 0 = off */
    soft_trail_money_arm?: number;
    /** Soft-trail pullback distance in pips (default 0.3) */
    soft_trail_pips?: number;
    /** VS-System 10%/20% broker SL chase */
    scalp_pct_chase?: boolean;
    /** Lock fraction (default 0.2) */
    scalp_lock_pct?: number;
    /**
     * When set, quotes older than this skip soft manage (BE/trail/TIME_STOP/partial)
     * but still attempt naked SL recovery — Check- stale bridge gate.
     */
    stale_quote_ms?: number;
  }): Promise<ManageTickResult> {
    const { broker, pipeline, quote } = input;
    const pv = input.instrument_point_value ?? 1;
    const maxHold = input.max_hold_ms ?? 0;
    const beProgress = input.breakeven_progress ?? 0.5;
    const beOffset = input.breakeven_offset ?? 0;
    const beStart = input.be_start ?? 0;
    const beMoney = input.breakeven_activation_money ?? 0;
    const softMoneyArm = input.soft_trail_money_arm ?? 0;
    const softPips = input.soft_trail_pips ?? 0.3;
    const scalpChase = input.scalp_pct_chase === true;
    const scalpLock =
      input.scalp_lock_pct != null &&
      Number.isFinite(input.scalp_lock_pct) &&
      input.scalp_lock_pct > 0 &&
      input.scalp_lock_pct <= 1
        ? Number(input.scalp_lock_pct)
        : SCALP_LOCK_PCT;
    const trailStart = input.trail_start ?? 0;
    const trailLock = input.trail_lock ?? 0;
    const partialProgress = input.partial_close_progress ?? 0;
    const partialVolume = input.partial_close_volume ?? 0;
    const volumeStep = input.volume_step ?? 0.01;
    const swingLow = input.swing_low ?? null;
    const swingHigh = input.swing_high ?? null;
    const trailBuf = input.trailing_buffer ?? 0;
    const minStopDist = input.min_stop_distance ?? quote.min_stop_distance ?? null;
    const allowClose = input.allow_close !== false;
    const closeAllProfit = input.close_all_profit ?? 0;
    const closeAllLoss = input.close_all_loss ?? 0;
    const closed: ManageTickResult['closed'] = [];
    const close_failed: ManageTickResult['close_failed'] = [];

    // Check- stale market: no soft manage / portfolio closes on dead quotes
    const staleMs = input.stale_quote_ms ?? 0;
    const quoteStale =
      staleMs > 0 &&
      Number.isFinite(quote.ts_ms) &&
      Date.now() - quote.ts_ms > staleMs;
    if (quoteStale) {
      for (const pos of this.list()) {
        if (pos.stop_loss == null) {
          await this.maybeRecoverNakedStop(broker, pos, quote, minStopDist);
        }
      }
      return { closed, close_failed, modified: 0 };
    }

    // Check- portfolio close-all on floating PnL (before per-position manage)
    const floatPnl = floatingUnrealizedPnl(this.list(), quote, pv);
    const portfolioReason =
      closeAllProfit > 0 && floatPnl >= closeAllProfit
        ? `AUTO_PROFIT_${floatPnl.toFixed(2)}`
        : closeAllLoss > 0 && floatPnl <= -closeAllLoss
          ? `AUTO_LOSS_${floatPnl.toFixed(2)}`
          : null;
    if (portfolioReason) {
      for (const pos of [...this.open.values()]) {
        const mark = protectiveMark(pos.side, quote);
        const heldMs = Date.now() - new Date(pos.entry_at).getTime();
        if (await this.softCloseRequiresSlBlocked(broker, pos)) {
          close_failed.push({
            position_id: pos.position_id,
            exit_reason: portfolioReason,
            detail: 'close_requires_sl',
          });
          continue;
        }
        const closeRes = await broker.closePosition(pos.position_id);
        if (!closeRes.ok) {
          close_failed.push({
            position_id: pos.position_id,
            exit_reason: portfolioReason,
            detail: closeRes.detail || 'close_failed',
          });
          continue;
        }
        const fill =
          closeRes.fill_price != null && Number.isFinite(closeRes.fill_price)
            ? Number(closeRes.fill_price)
            : mark;
        const { pnl, pnl_pts: pnlPts } = resolveCloseMoneyPnl({
          side: pos.side,
          entry: pos.entry,
          fill,
          size: pos.size,
          value_per_point_per_lot: pv,
          fill_pnl: closeRes.fill_pnl,
        });
        const riskDist = Math.max(
          Math.abs((pos.stop_loss ?? pos.entry) - pos.entry),
          Number.EPSILON
        );
        const outcome: TradeOutcome = {
          position_id: pos.position_id,
          side: pos.side,
          entry: pos.entry,
          exit: fill,
          volume: pos.size,
          pnl,
          fees: 0,
          slippage: Math.abs(fill - quote.mid),
          mae: pos.mae,
          mfe: pos.mfe,
          r_multiple: pnlPts / riskDist,
          hold_ms: heldMs,
          exit_reason: portfolioReason,
        };
        pipeline.recordTradeClose(pos.opportunity_id, pos.decision, outcome, {
          epic: pos.epic,
        });
        this.open.delete(pos.position_id);
        closed.push({ position: pos, outcome, reason: portfolioReason });
      }
      return { closed, close_failed, open_count: this.open.size };
    }

    for (const pos of [...this.open.values()]) {
      const mark = protectiveMark(pos.side, quote);
      const fav = favorableMove(pos.side, pos.entry, mark);
      pos.mfe = Math.max(pos.mfe, fav);
      pos.mae = Math.max(pos.mae, -fav);
      const peak_retention =
        pos.mfe > 1e-9 ? Math.max(0, Math.min(1, fav / pos.mfe)) : null;
      const heldMs = Date.now() - new Date(pos.entry_at).getTime();

      const moneyPnl = resolveFloatingMoneyPnl({
        side: pos.side,
        entry: pos.entry,
        mark,
        size: pos.size,
        value_per_point_per_lot: pv,
        broker_upl: pos.broker_upl,
      });

      // Never-naked: broker-truth null SL → attach 10% protective before soft exits
      if (pos.stop_loss == null && broker.modifyPosition) {
        await this.maybeRecoverNakedStop(broker, pos, quote, minStopDist);
      }

      // VS-System soft trail — software exit after money arm (not Capital min-stop trail)
      if (allowClose && softMoneyArm > 0) {
        const arm = decideSoftTrailArm({
          money_pnl: moneyPnl,
          money_arm: softMoneyArm,
          already_armed: !!pos.soft_trail_armed_at,
        });
        if (arm.run) {
          if (!pos.soft_trail_armed_at) {
            pos.soft_trail_armed_at = new Date().toISOString();
            pos.soft_trail_peak = mark;
          } else {
            pos.soft_trail_peak = updateSoftTrailPeak(
              pos.side,
              mark,
              pos.soft_trail_peak
            );
          }
          const dist = softTrailDistancePrice(pos.epic, softPips);
          const peak = pos.soft_trail_peak ?? mark;
          const exitLvl = softTrailExitLevel(pos.side, peak, dist);
          if (softTrailExitHit(pos.side, mark, exitLvl)) {
            if (await this.softCloseRequiresSlBlocked(broker, pos)) {
              close_failed.push({
                position_id: pos.position_id,
                exit_reason: 'SOFT_TRAIL',
                detail: 'close_requires_sl',
              });
            } else {
              const closeRes = await broker.closePosition(pos.position_id);
              if (closeRes.ok) {
                const fill =
                  closeRes.fill_price != null && Number.isFinite(closeRes.fill_price)
                    ? Number(closeRes.fill_price)
                    : mark;
                const { pnl } = resolveCloseMoneyPnl({
                  side: pos.side,
                  entry: pos.entry,
                  fill,
                  size: pos.size,
                  value_per_point_per_lot: pv,
                  fill_pnl: closeRes.fill_pnl,
                });
                const outcome: TradeOutcome = {
                  position_id: pos.position_id,
                  side: pos.side,
                  entry: pos.entry,
                  exit: fill,
                  volume: pos.size,
                  pnl,
                  fees: 0,
                  slippage: Math.abs(fill - quote.mid),
                  mae: pos.mae,
                  mfe: pos.mfe,
                  r_multiple: 0,
                  hold_ms: heldMs,
                  exit_reason: `SOFT_TRAIL · money≥${softMoneyArm} pullback ${softPips}pip`,
                };
                pipeline.recordTradeClose(pos.opportunity_id, pos.decision, outcome, {
                  epic: pos.epic,
                });
                this.open.delete(pos.position_id);
                closed.push({
                  position: pos,
                  outcome,
                  reason: outcome.exit_reason,
                });
                continue;
              }
              close_failed.push({
                position_id: pos.position_id,
                exit_reason: 'SOFT_TRAIL',
                detail: closeRes.detail || 'soft_trail_close_failed',
              });
            }
          }
        }
      }

      // VS-System multi-TP ladder (app-managed) before single Reader partial
      if (
        allowClose &&
        broker.supportsPartialClose !== false &&
        pos.multi_tp_levels &&
        pos.multi_tp_levels.length >= 2
      ) {
        const ladder = await this.maybeMultiTpScaleOut({
          broker,
          pipeline,
          pos,
          quote,
          mark,
          heldMs,
          pv,
          volumeStep,
        });
        if (ladder.handled) {
          if (ladder.closed) closed.push(...ladder.closed);
          if (ladder.close_failed) close_failed.push(...ladder.close_failed);
          if (ladder.removed) continue;
          // Remaining runner — fall through to protective / trail
        }
      } else if (
        // Reader partial scale-out before full exit (once)
        // Skip when broker cannot partial (Check- MT4 full-lots CLOSE only)
        allowClose &&
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
          if (await this.softCloseRequiresSlBlocked(broker, pos)) {
            close_failed.push({
              position_id: pos.position_id,
              exit_reason: partial.reason,
              detail: 'close_requires_sl',
            });
          } else {
            const closeRes = await broker.closePosition(pos.position_id, {
              size: partial.close_size,
            });
            if (closeRes.ok) {
              const fill =
                closeRes.fill_price != null && Number.isFinite(closeRes.fill_price)
                  ? Number(closeRes.fill_price)
                  : mark;
              const { pnl } = resolveCloseMoneyPnl({
                side: pos.side,
                entry: pos.entry,
                fill,
                size: partial.close_size,
                value_per_point_per_lot: pv,
                fill_pnl: closeRes.fill_pnl,
              });
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
        await this.maybeBreakevenStop(broker, pos, quote, {
          progressNeed: beProgress,
          offset: beOffset,
          beStart,
          moneyNeed: beMoney,
          pointValue: pv,
          min_stop_distance: minStopDist,
        });
        if (scalpChase) {
          await this.maybeArmNativeTrailingStop(broker, pos, quote, {
            lockPct: scalpLock,
            min_stop_distance: minStopDist,
          });
          await this.maybeScalpPctChaseStop(broker, pos, quote, {
            lockPct: scalpLock,
            min_stop_distance: minStopDist,
          });
        } else {
          await this.maybeTrailStop(broker, pos, quote, {
            swing_low: swingLow,
            swing_high: swingHigh,
            trailing_buffer: trailBuf,
            trail_start: trailStart,
            trail_lock: trailLock,
            min_stop_distance: minStopDist,
          });
        }
        continue;
      }

      // Reader AI: soft exits vetoed; hard STOP/TP always fire
      const hardProtective =
        protective != null &&
        (verdict.reason === 'STOP_HIT' || verdict.reason === 'TP_HIT');
      if (!allowClose && !hardProtective) {
        close_failed.push({
          position_id: pos.position_id,
          exit_reason: verdict.reason,
          detail: 'ai_veto_close',
        });
        await this.maybeBreakevenStop(broker, pos, quote, {
          progressNeed: beProgress,
          offset: beOffset,
          beStart,
          moneyNeed: beMoney,
          pointValue: pv,
          min_stop_distance: minStopDist,
        });
        if (scalpChase) {
          await this.maybeArmNativeTrailingStop(broker, pos, quote, {
            lockPct: scalpLock,
            min_stop_distance: minStopDist,
          });
          await this.maybeScalpPctChaseStop(broker, pos, quote, {
            lockPct: scalpLock,
            min_stop_distance: minStopDist,
          });
        } else {
          await this.maybeTrailStop(broker, pos, quote, {
            swing_low: swingLow,
            swing_high: swingHigh,
            trailing_buffer: trailBuf,
            trail_start: trailStart,
            trail_lock: trailLock,
            min_stop_distance: minStopDist,
          });
        }
        continue;
      }

      // VS-System close-requires-SL — soft/app closes need visible chart protection
      if (!hardProtective && (await this.softCloseRequiresSlBlocked(broker, pos))) {
        close_failed.push({
          position_id: pos.position_id,
          exit_reason: verdict.reason,
          detail: 'close_requires_sl',
        });
        await this.maybeBreakevenStop(broker, pos, quote, {
          progressNeed: beProgress,
          offset: beOffset,
          beStart,
          moneyNeed: beMoney,
          pointValue: pv,
          min_stop_distance: minStopDist,
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
      const { pnl, pnl_pts: pnlPts } = resolveCloseMoneyPnl({
        side: pos.side,
        entry: pos.entry,
        fill: exit,
        size: pos.size,
        value_per_point_per_lot: pv,
        fill_pnl: closeRes.fill_pnl,
      });
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
   * VS-System multi-TP — process all hit PENDING/FAILED levels this tick (gap-through).
   * Intermediate = partial; final = full close remaining.
   */
  private async maybeMultiTpScaleOut(input: {
    broker: MasterBroker;
    pipeline: MasterPipeline;
    pos: ManagedPosition;
    quote: Quote;
    mark: number;
    heldMs: number;
    pv: number;
    volumeStep: number;
  }): Promise<{
    handled: boolean;
    removed?: boolean;
    closed?: ManageTickResult['closed'];
    close_failed?: ManageTickResult['close_failed'];
  }> {
    const { broker, pipeline, pos, quote, mark, heldMs, pv, volumeStep } = input;
    const levels = pos.multi_tp_levels;
    if (!levels?.length) return { handled: false };

    const closed: ManageTickResult['closed'] = [];
    const close_failed: ManageTickResult['close_failed'] = [];
    let any = false;

    // Gap-through: walk levels in order while mark still hits
    while (true) {
      const idx = multiTpPendingIndex(levels);
      if (idx < 0) break;
      const level = levels[idx]!;
      if (!multiTpHit(pos.side, mark, level.price)) break;
      any = true;

      const isFinal = idx === levels.length - 1;
      if (await this.softCloseRequiresSlBlocked(broker, pos)) {
        close_failed.push({
          position_id: pos.position_id,
          exit_reason: `MULTI_TP_${level.index}`,
          detail: 'close_requires_sl',
        });
        level.status = 'FAILED';
        break;
      }

      const closeSize = clampCloseVolume(
        level.close_volume,
        pos.size,
        volumeStep,
        isFinal
      );
      if (closeSize == null || closeSize <= 0) {
        level.status = 'FAILED';
        break;
      }

      const closeRes = isFinal
        ? await broker.closePosition(pos.position_id)
        : await broker.closePosition(pos.position_id, { size: closeSize });

      if (!closeRes.ok) {
        level.status = 'FAILED';
        close_failed.push({
          position_id: pos.position_id,
          exit_reason: `MULTI_TP_${level.index}`,
          detail: closeRes.detail || 'multi_tp_close_failed',
        });
        break;
      }

      const fill =
        closeRes.fill_price != null && Number.isFinite(closeRes.fill_price)
          ? Number(closeRes.fill_price)
          : mark;
      const vol = isFinal ? pos.size : closeSize;
      const { pnl } = resolveCloseMoneyPnl({
        side: pos.side,
        entry: pos.entry,
        fill,
        size: vol,
        value_per_point_per_lot: pv,
        fill_pnl: closeRes.fill_pnl,
      });
      const outcome: TradeOutcome = {
        position_id: pos.position_id,
        side: pos.side,
        entry: pos.entry,
        exit: fill,
        volume: vol,
        pnl,
        fees: 0,
        slippage: Math.abs(fill - quote.mid),
        mae: pos.mae,
        mfe: pos.mfe,
        r_multiple: 0,
        hold_ms: heldMs,
        exit_reason: `MULTI_TP_${level.index}${isFinal ? '_FINAL' : ''}`,
      };
      pipeline.recordTradeClose(pos.opportunity_id, pos.decision, outcome, {
        epic: pos.epic,
      });
      level.status = 'EXECUTED';
      closed.push({ position: { ...pos }, outcome, reason: outcome.exit_reason });

      if (isFinal) {
        this.open.delete(pos.position_id);
        return { handled: true, removed: true, closed, close_failed };
      }

      const rem =
        closeRes.remaining_size != null && Number.isFinite(closeRes.remaining_size)
          ? Number(closeRes.remaining_size)
          : Math.max(0, pos.size - closeSize);
      pos.size = rem;
      pos.partial_close_applied = true;
      if (rem <= 1e-9) {
        this.open.delete(pos.position_id);
        return { handled: true, removed: true, closed, close_failed };
      }
    }

    return { handled: any, removed: false, closed, close_failed };
  }

  /**
   * Apply Capital-safe stop modify with per-position reject backoff
   * (VS-System scalpModifyBackoffUntil pattern).
   */
  private async applyProtectiveStopModify(
    broker: MasterBroker,
    pos: ManagedPosition,
    stop: number,
    mark: number,
    minStopDist: number | null | undefined
  ): Promise<boolean> {
    if (!broker.modifyPosition) return false;
    const clamped = clampStopForCapitalMark({
      side: pos.side,
      stop,
      mark,
      symbol: pos.epic,
      current_stop: pos.stop_loss,
      min_distance: minStopDist,
    });
    if (clamped == null) return false;

    const backoff = this.modifyBackoff.get(pos.position_id);
    const now = Date.now();
    if (
      backoff &&
      now < backoff.until &&
      Math.abs(backoff.level - clamped) < 1e-9
    ) {
      return false;
    }

    const mod = await broker.modifyPosition({
      position_id: pos.position_id,
      stop_level: clamped,
    });
    if (mod.ok) {
      pos.stop_loss = clamped;
      this.modifyBackoff.delete(pos.position_id);
      return true;
    }
    const { capitalModifyRejectBackoffMs } = await import('./capitalConfirm.js');
    this.modifyBackoff.set(pos.position_id, {
      until: now + capitalModifyRejectBackoffMs(mod.detail || ''),
      level: clamped,
    });
    return false;
  }

  /**
   * VS-System assertStopLossBeforeClose — force-list chart SL before soft/app close.
   * Returns true when close must be blocked (detail: close_requires_sl).
   */
  private async softCloseRequiresSlBlocked(
    broker: MasterBroker,
    pos: ManagedPosition
  ): Promise<boolean> {
    let brokerFound: boolean | null = null;
    let brokerStop: number | string | null = null;
    try {
      const listed = await broker.listOpenPositions(pos.epic);
      if (!listed.ok) {
        brokerFound = null;
      } else {
        const match = listed.positions.find((p) => p.position_id === pos.position_id);
        brokerFound = !!match;
        brokerStop = match?.stop_level ?? null;
      }
    } catch {
      brokerFound = null;
    }
    return !closeAllowedByStopLoss({
      brokerFound,
      brokerStopLoss: brokerStop,
      dbStopLoss: pos.stop_loss,
    });
  }

  private async maybeRecoverNakedStop(
    broker: MasterBroker,
    pos: ManagedPosition,
    quote: Quote,
    minStopDist: number | null | undefined
  ): Promise<void> {
    if (!broker.modifyPosition) return;
    if (pos.stop_loss != null) return;
    const now = Date.now();
    const last = this.nakedRecoveryAt.get(pos.position_id) ?? 0;
    if (now - last < PositionManager.NAKED_RECOVERY_MS) return;
    this.nakedRecoveryAt.set(pos.position_id, now);

    const mark = protectiveMark(pos.side, quote);
    const level = this.nakedRecoveryLevel.get(pos.position_id) ?? 0;
    const mult =
      PositionManager.NAKED_RECOVERY_MULTS[
        Math.min(level, PositionManager.NAKED_RECOVERY_MULTS.length - 1)
      ]!;
    const baseDist = scalpInitialStopDistance(pos.entry);
    const dist =
      (Number.isFinite(baseDist) ? baseDist : 0) * (level === 0 ? 1 : mult);

    const { capitalSafeInitialStop } = await import('./capitalStop.js');
    const recovery =
      level === 0
        ? scalpInitialBrokerStop({
            symbol: pos.epic,
            direction: pos.side,
            entry: pos.entry,
            mark,
            min_distance: minStopDist,
          })
        : capitalSafeInitialStop({
            symbol: pos.epic,
            direction: pos.side,
            entry: pos.entry,
            distance: dist,
            mark,
            min_distance: minStopDist,
          });
    if (recovery == null) return;

    const mod = await broker.modifyPosition({
      position_id: pos.position_id,
      stop_level: recovery,
    });
    if (mod.ok) {
      pos.stop_loss = recovery;
      this.modifyBackoff.delete(pos.position_id);
      this.nakedRecoveryLevel.delete(pos.position_id);
      return;
    }
    this.nakedRecoveryLevel.set(pos.position_id, level + 1);
    const { capitalModifyRejectBackoffMs } = await import('./capitalConfirm.js');
    this.modifyBackoff.set(pos.position_id, {
      until: now + capitalModifyRejectBackoffMs(mod.detail || ''),
      level: recovery,
    });
  }

  /**
   * Arm Capital native trailingStop once in profit (survives process death).
   * App-side 20% chase still runs; native trail is broker-side backup.
   */
  private async maybeArmNativeTrailingStop(
    broker: MasterBroker,
    pos: ManagedPosition,
    quote: Quote,
    opts: { lockPct: number; min_stop_distance?: number | null }
  ): Promise<void> {
    if (!broker.modifyPosition || pos.native_trail_armed) return;
    const mark = protectiveMark(pos.side, quote);
    const fav = favorableMove(pos.side, pos.entry, mark);
    const minD = effectiveMinStopDistance(pos.epic, opts.min_stop_distance);
    // Need clear profit beyond min-stop before asking Capital for native trail
    if (!(fav > minD * 1.5)) return;

    const dist = Math.max(minD, fav * opts.lockPct);
    const mod = await broker.modifyPosition({
      position_id: pos.position_id,
      trailing_stop: true,
      stop_distance: dist,
    });
    if (mod.ok) {
      pos.native_trail_armed = true;
      // Refresh local SL guess from mark −/+ dist
      const guess =
        pos.side === 'BUY' ? mark - dist : mark + dist;
      if (pos.stop_loss == null) pos.stop_loss = guess;
      else if (pos.side === 'BUY' && guess > pos.stop_loss) pos.stop_loss = guess;
      else if (pos.side === 'SELL' && guess < pos.stop_loss) pos.stop_loss = guess;
    }
  }

  /**
   * VS-System 10%/20% SCALPING broker SL chase — improve-only Capital stopLevel.
   * Replaces structure/MFE trail when scalp_pct_chase is enabled.
   */
  private async maybeScalpPctChaseStop(
    broker: MasterBroker,
    pos: ManagedPosition,
    quote: Quote,
    opts: { lockPct: number; min_stop_distance?: number | null }
  ): Promise<void> {
    if (!broker.modifyPosition) return;
    const mark = protectiveMark(pos.side, quote);
    const now = Date.now();
    const last = this.scalpChaseAt.get(pos.position_id) ?? 0;
    if (now - last < SCALP_SL_CHASE_MIN_INTERVAL_MS) return;

    const candidate = scalpPctLockBrokerStop({
      symbol: pos.epic,
      direction: pos.side,
      entry: pos.entry,
      livePrice: mark,
      lockPct: opts.lockPct,
      min_distance: opts.min_stop_distance,
    });
    if (candidate == null) return;

    if (
      !scalpChaseIsImprovement({
        direction: pos.side,
        candidate,
        current: pos.stop_loss,
      })
    ) {
      return;
    }

    const backoff = this.modifyBackoff.get(pos.position_id);
    if (
      backoff &&
      now < backoff.until &&
      Math.abs(backoff.level - candidate) < 1e-9
    ) {
      return;
    }

    // Already Capital-legal from scalpPctLockBrokerStop — still clamp for live min
    const clamped = clampStopForCapitalMark({
      side: pos.side,
      stop: candidate,
      mark,
      symbol: pos.epic,
      current_stop: pos.stop_loss,
      min_distance: opts.min_stop_distance,
    });
    // When clamp rejects because candidate is still below entry while mark is
    // close (favorable < minD), push candidate directly if still improve-only
    // and valid vs mark soft floor.
    const stop = clamped ?? candidate;
    if (
      !scalpChaseIsImprovement({
        direction: pos.side,
        candidate: stop,
        current: pos.stop_loss,
      })
    ) {
      return;
    }

    this.scalpChaseAt.set(pos.position_id, now);
    const mod = await broker.modifyPosition({
      position_id: pos.position_id,
      stop_level: stop,
    });
    if (mod.ok) {
      pos.stop_loss = stop;
      this.modifyBackoff.delete(pos.position_id);
      return;
    }
    const { capitalModifyRejectBackoffMs } = await import('./capitalConfirm.js');
    this.modifyBackoff.set(pos.position_id, {
      until: now + capitalModifyRejectBackoffMs(mod.detail || ''),
      level: stop,
    });
  }

  /**
   * Reader-style breakeven (progress-to-TP) + Check- be_start/offset.
   * Check be_start > 0 arms BE without requiring take_profit (orphan recover).
   * Only tightens; never loosens. Capital-safe vs mark.
   */
  private async maybeBreakevenStop(
    broker: MasterBroker,
    pos: ManagedPosition,
    quote: Quote,
    opts: {
      progressNeed: number;
      offset?: number;
      beStart?: number;
      moneyNeed?: number;
      pointValue?: number;
      min_stop_distance?: number | null;
    }
  ): Promise<void> {
    if (!broker.modifyPosition) return;
    const offset = Math.max(0, opts.offset ?? 0);
    const beStart = Math.max(0, opts.beStart ?? 0);
    const moneyNeed = Math.max(0, opts.moneyNeed ?? 0);
    const progressNeed = opts.progressNeed;
    const mark = protectiveMark(pos.side, quote);
    const fav = favorableMove(pos.side, pos.entry, mark);
    const money = resolveFloatingMoneyPnl({
      side: pos.side,
      entry: pos.entry,
      mark,
      size: pos.size,
      value_per_point_per_lot: opts.pointValue ?? 1,
      broker_upl: pos.broker_upl,
    });

    let armed = false;
    if (moneyNeed > 0 && money >= moneyNeed) armed = true;
    if (!armed && beStart > 0) armed = fav >= beStart;
    if (!armed && progressNeed > 0 && pos.take_profit != null) {
      const tpDist = Math.abs(pos.take_profit - pos.entry);
      if (tpDist >= 1e-9 && fav / tpDist >= progressNeed) armed = true;
    }
    if (!armed) return;

    // Defer until entry±offset is Capital-legal — never clamp BE into a loss
    const be = capitalSafeBreakEvenStop({
      side: pos.side,
      entry: pos.entry,
      mark,
      symbol: pos.epic,
      offset,
      current_stop: pos.stop_loss,
      min_distance: opts.min_stop_distance,
    });
    if (be == null) return;

    const backoff = this.modifyBackoff.get(pos.position_id);
    const now = Date.now();
    if (backoff && now < backoff.until && Math.abs(backoff.level - be) < 1e-9) {
      return;
    }
    const mod = await broker.modifyPosition({
      position_id: pos.position_id,
      stop_level: be,
    });
    if (mod.ok) {
      pos.stop_loss = be;
      this.modifyBackoff.delete(pos.position_id);
      return;
    }
    const { capitalModifyRejectBackoffMs } = await import('./capitalConfirm.js');
    this.modifyBackoff.set(pos.position_id, {
      until: now + capitalModifyRejectBackoffMs(mod.detail || ''),
      level: be,
    });
  }

  /**
   * Trail SL — Check point trail, then Reader structure swings, else MFE 50% ratchet.
   * Only tightens; never loosens. Capital-safe vs mark.
   */
  private async maybeTrailStop(
    broker: MasterBroker,
    pos: ManagedPosition,
    quote: Quote,
    structure?: {
      swing_low?: number | null;
      swing_high?: number | null;
      trailing_buffer?: number;
      trail_start?: number;
      trail_lock?: number;
      min_stop_distance?: number | null;
    }
  ): Promise<void> {
    if (!broker.modifyPosition) return;
    const mark = protectiveMark(pos.side, quote);
    const buf = structure?.trailing_buffer ?? 0;
    const trailStart = structure?.trail_start ?? 0;
    const trailLock = structure?.trail_lock ?? 0;
    let trailed: number | null = null;

    // Check- hard-point trail (no TP required)
    if (trailStart > 0 && trailLock > 0) {
      const fav = favorableMove(pos.side, pos.entry, mark);
      if (fav >= trailStart) {
        trailed =
          pos.side === 'BUY' ? mark - trailLock : mark + trailLock;
      }
    }

    if (trailed == null && pos.side === 'BUY') {
      const swing = structure?.swing_low;
      if (swing != null && Number.isFinite(swing) && swing > 0 && buf >= 0) {
        const cand = swing - buf;
        if (cand < mark && (pos.stop_loss == null || cand > pos.stop_loss)) {
          trailed = cand;
        }
      }
    } else if (trailed == null) {
      const swing = structure?.swing_high;
      if (swing != null && Number.isFinite(swing) && swing > 0 && buf >= 0) {
        const cand = swing + buf;
        if (cand > mark && (pos.stop_loss == null || cand < pos.stop_loss)) {
          trailed = cand;
        }
      }
    }

    // MFE ratchet only when structure/Check did not produce a trail
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
    await this.applyProtectiveStopModify(
      broker,
      pos,
      trailed,
      mark,
      structure?.min_stop_distance
    );
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
      upl?: number | null;
      opened_at?: string | null;
    }>
  ): { external_partials: ExternalPartialEvent[] } {
    const external_partials: ExternalPartialEvent[] = [];
    const brokerIds = new Set(brokerPositions.map((p) => p.position_id));
    for (const id of [...this.open.keys()]) {
      if (!brokerIds.has(id)) this.open.delete(id);
    }
    for (const bp of brokerPositions) {
      const existing = this.open.get(bp.position_id);
      if (existing) {
        // External/manual/missed-ACK shrink → journal closed slice (Reader)
        if (bp.size > 0 && bp.size < existing.size - 1e-9) {
          const closed_size = existing.size - bp.size;
          const broker_upl_closed =
            existing.broker_upl != null &&
            Number.isFinite(existing.broker_upl) &&
            existing.size > 1e-12
              ? (Number(existing.broker_upl) * closed_size) / existing.size
              : null;
          external_partials.push({
            position_id: existing.position_id,
            opportunity_id: existing.opportunity_id,
            intent_id: existing.intent_id,
            epic: existing.epic,
            side: existing.side,
            entry: existing.entry,
            closed_size,
            remaining_size: bp.size,
            mark_proxy: bp.open_level,
            decision: existing.decision,
            mae: existing.mae,
            mfe: existing.mfe,
            broker_upl_closed,
          });
          existing.partial_close_applied = true;
        }
        // Refresh protective levels from broker truth.
        // Null broker SL clears stale local SL so mid-life naked recovery can fire
        // (VS-System: never trust DB/local when chart is naked).
        if (bp.stop_level != null) {
          existing.stop_loss = bp.stop_level;
        } else {
          existing.stop_loss = null;
        }
        if (bp.profit_level != null) existing.take_profit = bp.profit_level;
        if (bp.size > 0) existing.size = bp.size;
        if (bp.upl !== undefined) {
          existing.broker_upl =
            bp.upl != null && Number.isFinite(bp.upl) ? Number(bp.upl) : null;
        }
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
        broker_upl:
          bp.upl != null && Number.isFinite(bp.upl) ? Number(bp.upl) : null,
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
        partial_close_applied: false,
      });
    }
    return { external_partials };
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

/** Floating UPL across open positions using protective marks + broker UPL when known. */
export function floatingUnrealizedPnl(
  positions: Array<
    Pick<ManagedPosition, 'side' | 'entry' | 'size' | 'broker_upl'>
  >,
  quote: Quote,
  pointValue = 1
): number {
  let sum = 0;
  for (const pos of positions) {
    const mark = protectiveMark(pos.side, quote);
    sum += resolveFloatingMoneyPnl({
      side: pos.side,
      entry: pos.entry,
      mark,
      size: pos.size,
      value_per_point_per_lot: pointValue,
      broker_upl: pos.broker_upl,
    });
  }
  return sum;
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
