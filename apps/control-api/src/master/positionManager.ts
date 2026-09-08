/**
 * POSITION MANAGER + EXIT — tracks open MASTER positions and applies
 * Best Outcome exit (decideBestOutcomeExit from live desk playbooks).
 */
import { createHash } from 'crypto';
import { decideBestOutcomeExit, favorableMove } from '../services/exitManage.js';
import { playbookFromRegime } from '../services/playbooks.js';
import { ema13CrossExit, ema3PriceSide, ema3PriceThroughExit } from './analysis.js';
import type { MasterBroker } from './broker.js';
import { epicsMatch } from './broker.js';
import { clampStopForCapitalMark, effectiveMinStopDistance } from './capitalStop.js';
import {
  clampCloseVolume,
  multiTpFinalPrice,
  multiTpHit,
  multiTpPendingIndex,
  type MultiTpLevel,
} from './multiTp.js';
import {
  capitalCloseExitReason,
  capitalSafeBreakEvenStop,
  decideSoftTrailArm,
  preferCloseFillPnl,
  priceResolvedCloseMoney,
  resolveCloseMoneyPnl,
  resolveCloseExitFill,
  resolveFloatingMoneyPnl,
  softTrailDistancePrice,
  softTrailExitHit,
  softTrailExitLevel,
  updateSoftTrailPeak,
  usableBrokerUpl,
} from './moneyExit.js';
import { closeAllowedByStopLoss } from './closeRequiresSl.js';
import type { MasterPipeline } from './pipeline.js';
import { logTradeEvent } from './tradeEventJournal.js';
import {
  SCALP_LOCK_PCT,
  SCALP_SL_CHASE_MIN_INTERVAL_MS,
  scalpChaseIsImprovement,
  scalpInitialBrokerStop,
  scalpInitialStopDistance,
  scalpMinStopImprovement,
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
  /** Locked playbook at entry (desk LONG/SCALP/FADE) */
  playbook_at_entry?: 'LONG' | 'SCALP' | 'FADE';
  /** Locked setup kind at entry — CONTINUATION / FADE / … */
  entry_setup?: string;
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
  /** Last scalp % chase attempt ms — durable so restart does not MODIFY-hammer */
  scalp_chase_at_ms?: number | null;
  /** Last price side vs EMA3 (above/below) for price-through exit */
  ema3_side?: 'above' | 'below' | null;
  /** Durable identical rejected stop level (survives restart) */
  modify_reject_level?: number | null;
  /** Durable modify time-backoff until ms */
  modify_backoff_until_ms?: number | null;
  /**
   * Structure levels wanted at OPEN — survive mid-life broker strip so sync can
   * re-attach intended SL/TP instead of only soft safety_sl.
   */
  intended_stop_loss?: number | null;
  intended_take_profit?: number | null;
  /** Durable naked SL recovery escalate level (0..3) across restart */
  naked_recovery_level?: number | null;
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
  /** Rejected stop level — skip identical candidate only while backoff is active */
  private rejectedStopLevel = new Map<string, number>();
  /** VS-System naked SL recovery throttle */
  private nakedRecoveryAt = new Map<string, number>();
  /** VS-System escalate distance on reject: multipliers [1,2,3,5] */
  private nakedRecoveryLevel = new Map<string, number>();
  private static readonly NAKED_RECOVERY_MS = 8_000;
  private static readonly NAKED_RECOVERY_MULTS = [1, 2, 3, 5] as const;

  private clearModifyReject(pos: ManagedPosition) {
    this.modifyBackoff.delete(pos.position_id);
    this.rejectedStopLevel.delete(pos.position_id);
    pos.modify_reject_level = null;
    pos.modify_backoff_until_ms = null;
  }

  private async noteModifyReject(
    pos: ManagedPosition,
    level: number,
    detail: string
  ): Promise<void> {
    const { capitalModifyRejectBackoffMs } = await import('./capitalConfirm.js');
    const until = Date.now() + capitalModifyRejectBackoffMs(detail || '');
    this.modifyBackoff.set(pos.position_id, { until, level });
    this.rejectedStopLevel.set(pos.position_id, level);
    pos.modify_reject_level = level;
    pos.modify_backoff_until_ms = until;
  }

  /**
   * Skip identical rejected stop only while time-backoff is active.
   * Fixed BE must retry after backoff — permanent blacklist froze Capital BE forever.
   */
  private shouldSkipModifyLevel(
    pos: ManagedPosition,
    level: number,
    opts?: { timeGateAll?: boolean }
  ): boolean {
    const until =
      pos.modify_backoff_until_ms ??
      this.modifyBackoff.get(pos.position_id)?.until;
    const rejected =
      pos.modify_reject_level ?? this.rejectedStopLevel.get(pos.position_id);
    const now = Date.now();
    const backoffActive = until != null && Number.isFinite(until) && now < until;

    if (rejected != null && Math.abs(rejected - level) < 1e-9) {
      if (!backoffActive) {
        this.clearModifyReject(pos);
        return false;
      }
      return true;
    }

    if (!backoffActive) return false;
    if (opts?.timeGateAll) return true;
    const backoffLevel =
      this.modifyBackoff.get(pos.position_id)?.level ?? rejected;
    return backoffLevel != null && Math.abs(backoffLevel - level) < 1e-9;
  }

  list(): ManagedPosition[] {
    return [...this.open.values()];
  }

  get(position_id: string) {
    return this.open.get(position_id) ?? null;
  }

  /** Operator / manual close — remove from local book after broker close succeeds. */
  drop(position_id: string): boolean {
    const pos = this.open.get(position_id);
    if (pos) this.clearModifyReject(pos);
    this.nakedRecoveryAt.delete(position_id);
    this.nakedRecoveryLevel.delete(position_id);
    return this.open.delete(position_id);
  }

  count() {
    return this.open.size;
  }

  countForEpic(epic: string) {
    return [...this.open.values()].filter((p) => epicsMatch(p.epic, epic)).length;
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
    /** Broker open time when known — preserve TIME_STOP clock on recover/adopt */
    entry_at?: string | null;
  }) {
    let take_profit = input.take_profit ?? null;
    const levels = input.multi_tp_levels?.length
      ? input.multi_tp_levels.map((l) => ({ ...l }))
      : undefined;
    if (levels?.length) {
      const final = multiTpFinalPrice(levels);
      if (final != null) take_profit = final;
    }
    const entryAt =
      input.entry_at && Number.isFinite(Date.parse(input.entry_at))
        ? new Date(input.entry_at).toISOString()
        : new Date().toISOString();
    const pos: ManagedPosition = {
      position_id: input.position_id,
      opportunity_id: input.opportunity_id,
      intent_id: input.intent_id,
      epic: input.epic,
      side: input.side,
      size: input.size,
      entry: input.entry,
      entry_at: entryAt,
      stop_loss: input.stop_loss ?? null,
      take_profit,
      intended_stop_loss:
        input.stop_loss != null &&
        Number.isFinite(input.stop_loss) &&
        Number(input.stop_loss) > 0
          ? Number(input.stop_loss)
          : null,
      intended_take_profit:
        take_profit != null &&
        Number.isFinite(take_profit) &&
        Number(take_profit) > 0
          ? Number(take_profit)
          : null,
      mfe: 0,
      mae: 0,
      decision: input.decision,
      regime_at_entry: toDeskRegime(
        input.decision.analysis.regime,
        input.decision.analysis
      ),
      playbook_at_entry: mapRegimeToPlaybook(
        input.decision.analysis.regime,
        input.decision.analysis
      ),
      entry_setup:
        mapRegimeToPlaybook(input.decision.analysis.regime, input.decision.analysis) ===
        'FADE'
          ? 'FADE'
          : 'CONTINUATION',
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
    /** VS-System EMA3 trail level (from live bars) */
    ema3?: number | null;
    /** VS-System EMA1 (≈ last close) for structural cross exit */
    ema1?: number | null;
    ema1_prev?: number | null;
    ema3_prev?: number | null;
    ema1_prev2?: number | null;
    ema3_prev2?: number | null;
    /**
     * When set, quotes older than this skip mark-based soft manage (BE/trail/partial/
     * BestOutcome) but still run TIME_STOP + naked SL recovery — feed-miss exits.
     */
    stale_quote_ms?: number;
    /** Live analysis regime for ThesisFailure (desk RegimeName when available) */
    live_regime?: string | null;
  }): Promise<ManageTickResult> {
    const { broker, pipeline, quote } = input;
    const capitalLive = broker.name === 'CAPITAL' && !broker.paper;
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
    const ema3 =
      input.ema3 != null && Number.isFinite(input.ema3) && input.ema3 > 0
        ? Number(input.ema3)
        : null;
    const ema1 =
      input.ema1 != null && Number.isFinite(input.ema1) ? Number(input.ema1) : null;
    const ema1Prev =
      input.ema1_prev != null && Number.isFinite(input.ema1_prev)
        ? Number(input.ema1_prev)
        : null;
    const ema3Prev =
      input.ema3_prev != null && Number.isFinite(input.ema3_prev)
        ? Number(input.ema3_prev)
        : null;
    const ema1Prev2 =
      input.ema1_prev2 != null && Number.isFinite(input.ema1_prev2)
        ? Number(input.ema1_prev2)
        : null;
    const ema3Prev2 =
      input.ema3_prev2 != null && Number.isFinite(input.ema3_prev2)
        ? Number(input.ema3_prev2)
        : null;
    const minStopDist = input.min_stop_distance ?? quote.min_stop_distance ?? null;
    const allowClose = input.allow_close !== false;
    const closeAllProfit = input.close_all_profit ?? 0;
    const closeAllLoss = input.close_all_loss ?? 0;
    const closed: ManageTickResult['closed'] = [];
    const close_failed: ManageTickResult['close_failed'] = [];

    // Check- stale market: skip mark-based soft manage / portfolio closes on dead quotes.
    // Hard STOP_HIT / TP_HIT still fire (protective levels are binding). TIME_STOP still runs.
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
      for (const pos of [...this.open.values()]) {
        const heldMs = Date.now() - new Date(pos.entry_at).getTime();
        const protective = protectiveExit(pos, quote);
        const timeStop =
          !protective && maxHold > 0 && heldMs >= maxHold
            ? {
                exit: true as const,
                reason: `TIME_STOP · held ${Math.round(heldMs / 1000)}s ≥ ${Math.round(maxHold / 1000)}s`,
              }
            : null;
        const verdict = protective ?? timeStop;
        if (!verdict) continue;
        const hardProtective = !!protective;
        // Soft TIME_STOP honors AI veto / close_requires_sl; hard SL/TP do not
        if (!hardProtective && !allowClose) {
          close_failed.push({
            position_id: pos.position_id,
            exit_reason: verdict.reason,
            detail: 'ai_veto_close',
          });
          continue;
        }
        if (!hardProtective && (await this.softCloseRequiresSlBlocked(broker, pos))) {
          close_failed.push({
            position_id: pos.position_id,
            exit_reason: verdict.reason,
            detail: 'close_requires_sl',
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
        const mark = protectiveMark(pos.side, quote);
        const { exit: fill, fill_proven } = resolveCloseExitFill({
          fill_price: closeRes.fill_price,
          mark,
          entry: pos.entry,
          capitalLive,
          hard_reason: protective?.reason ?? null,
          stop_loss: pos.stop_loss,
          take_profit: pos.take_profit,
        });
        const priced = priceResolvedCloseMoney({
          ...resolveCloseMoneyPnl({
            side: pos.side,
            entry: pos.entry,
            fill,
            size: pos.size,
            value_per_point_per_lot: pv,
            fill_pnl: preferCloseFillPnl({
              fill_pnl: closeRes.fill_pnl,
              broker_upl: pos.broker_upl,
            }),
            capitalLive,
          }),
          volume: pos.size,
        });
        const outcome: TradeOutcome = {
          position_id: pos.position_id,
          side: pos.side,
          entry: pos.entry,
          exit: fill,
          volume: pos.size,
          pnl: priced.pnl,
          fees: priced.fees,
          pnl_proven: priced.pnl_proven,
          slippage: fill_proven ? Math.abs(fill - quote.mid) : 0,
          mae: pos.mae,
          mfe: pos.mfe,
          r_multiple: 0,
          hold_ms: heldMs,
          exit_reason: capitalCloseExitReason(verdict.reason, priced.pnl_proven),
        };
        pipeline.recordTradeClose(pos.opportunity_id, pos.decision, outcome, {
          epic: pos.epic,
        });
        this.clearModifyReject(pos);
        this.open.delete(pos.position_id);
        closed.push({ position: pos, outcome, reason: outcome.exit_reason });
      }
      return { held: this.list(), closed, close_failed };
    }

    // Check- portfolio close-all on floating PnL (before per-position manage)
    // Capital LIVE: refuse portfolio money exits while any open lacks usable venue UPL
    const capitalFloatReady =
      !capitalLive ||
      this.list().every((p) => usableBrokerUpl(p.broker_upl) != null);
    const floatPnl = capitalFloatReady
      ? floatingUnrealizedPnl(this.list(), quote, pv, capitalLive)
      : 0;
    const portfolioReason =
      capitalFloatReady && closeAllProfit > 0 && floatPnl >= closeAllProfit
        ? `AUTO_PROFIT_${floatPnl.toFixed(2)}`
        : capitalFloatReady && closeAllLoss > 0 && floatPnl <= -closeAllLoss
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
        const { exit: fill, fill_proven } = resolveCloseExitFill({
          fill_price: closeRes.fill_price,
          mark,
          entry: pos.entry,
          capitalLive,
        });
        const priced = priceResolvedCloseMoney({
          ...resolveCloseMoneyPnl({
          side: pos.side,
          entry: pos.entry,
          fill,
          size: pos.size,
          value_per_point_per_lot: pv,
          fill_pnl: preferCloseFillPnl({
            fill_pnl: closeRes.fill_pnl,
            broker_upl: pos.broker_upl,
          }),
          capitalLive,
          }),
          volume: pos.size,
        });
        const pnlPts = priced.pnl_pts;
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
          pnl: priced.pnl,
          fees: priced.fees,
            pnl_proven: priced.pnl_proven,
          slippage: fill_proven ? Math.abs(fill - quote.mid) : 0,
          mae: pos.mae,
          mfe: pos.mfe,
          r_multiple: pnlPts / riskDist,
          hold_ms: heldMs,
          exit_reason: capitalCloseExitReason(portfolioReason, priced.pnl_proven),
        };
        pipeline.recordTradeClose(pos.opportunity_id, pos.decision, outcome, {
          epic: pos.epic,
        });
        this.open.delete(pos.position_id);
        closed.push({ position: pos, outcome, reason: outcome.exit_reason });
      }
      return { held: this.list(), closed, close_failed };
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
        capitalLive,
      });

      // Never-naked: broker-truth null SL → attach 10% protective before soft exits
      if (pos.stop_loss == null && broker.modifyPosition) {
        await this.maybeRecoverNakedStop(broker, pos, quote, minStopDist);
      }

      // Capital LIVE: soft mark exits need usable venue UPL (0 ≡ unread, like money helpers)
      const capitalUplReady =
        !capitalLive || usableBrokerUpl(pos.broker_upl) != null;

      // VS-System soft trail — SCALPING manage only, after money arm (not Capital min-stop trail)
      // Capital LIVE: refuse soft-trail (incl. already_armed) when venue UPL unread
      if (allowClose && softMoneyArm > 0 && scalpChase && capitalUplReady) {
        const arm = decideSoftTrailArm({
          money_pnl: moneyPnl,
          money_arm: softMoneyArm,
          already_armed: !!pos.soft_trail_armed_at,
          scalp_enabled: true,
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
                const { exit: fill, fill_proven } = resolveCloseExitFill({
                  fill_price: closeRes.fill_price,
                  mark,
                  entry: pos.entry,
                  capitalLive,
                });
                const priced = priceResolvedCloseMoney({
                  ...resolveCloseMoneyPnl({
                  side: pos.side,
                  entry: pos.entry,
                  fill,
                  size: pos.size,
                  value_per_point_per_lot: pv,
                  fill_pnl: preferCloseFillPnl({
                    fill_pnl: closeRes.fill_pnl,
                    broker_upl: pos.broker_upl,
                  }),
                  capitalLive,
                  }),
                  volume: pos.size,
                });
                const outcome: TradeOutcome = {
                  position_id: pos.position_id,
                  side: pos.side,
                  entry: pos.entry,
                  exit: fill,
                  volume: pos.size,
                  pnl: priced.pnl,
                  fees: priced.fees,
                  pnl_proven: priced.pnl_proven,
                  slippage: fill_proven ? Math.abs(fill - quote.mid) : 0,
                  mae: pos.mae,
                  mfe: pos.mfe,
                  r_multiple: 0,
                  hold_ms: heldMs,
                  exit_reason: capitalCloseExitReason(
                    `SOFT_TRAIL · money≥${softMoneyArm} pullback ${softPips}pip`,
                    priced.pnl_proven
                  ),
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

      // VS-System EMA_TICK: soft CLOSE on EMA1×EMA3 opposite cross or price-through EMA3
      if (ema3 != null) {
        const cross =
          allowClose &&
          capitalUplReady &&
          ema1 != null &&
          ema1Prev != null &&
          ema3Prev != null
            ? ema13CrossExit({
                side: pos.side,
                ema1,
                ema3,
                ema1Prev,
                ema3Prev,
                ema1Prev2,
                ema3Prev2,
              })
            : { exit: false, reason: '' };
        const thru =
          allowClose && capitalUplReady
            ? ema3PriceThroughExit({
                side: pos.side,
                mark,
                ema3,
                prevSide: pos.ema3_side,
              })
            : { exit: false, reason: '' };
        pos.ema3_side = ema3PriceSide(mark, ema3);
        const exitHit = cross.exit
          ? cross
          : thru.exit
            ? thru
            : { exit: false, reason: '' };
        if (exitHit.exit) {
          if (await this.softCloseRequiresSlBlocked(broker, pos)) {
            close_failed.push({
              position_id: pos.position_id,
              exit_reason: exitHit.reason,
              detail: 'close_requires_sl',
            });
          } else {
            const closeRes = await broker.closePosition(pos.position_id);
            if (closeRes.ok) {
              const { exit: fill, fill_proven } = resolveCloseExitFill({
                fill_price: closeRes.fill_price,
                mark,
                entry: pos.entry,
                capitalLive,
              });
              const priced = priceResolvedCloseMoney({
                ...resolveCloseMoneyPnl({
                side: pos.side,
                entry: pos.entry,
                fill,
                size: pos.size,
                value_per_point_per_lot: pv,
                fill_pnl: preferCloseFillPnl({
                  fill_pnl: closeRes.fill_pnl,
                  broker_upl: pos.broker_upl,
                }),
                capitalLive,
                }),
                volume: pos.size,
              });
              const outcome: TradeOutcome = {
                position_id: pos.position_id,
                side: pos.side,
                entry: pos.entry,
                exit: fill,
                volume: pos.size,
                pnl: priced.pnl,
                fees: priced.fees,
                pnl_proven: priced.pnl_proven,
                slippage: fill_proven ? Math.abs(fill - quote.mid) : 0,
                mae: pos.mae,
                mfe: pos.mfe,
                r_multiple: 0,
                hold_ms: heldMs,
                exit_reason: capitalCloseExitReason(
                  exitHit.reason,
                  priced.pnl_proven
                ),
              };
              pipeline.recordTradeClose(pos.opportunity_id, pos.decision, outcome, {
                epic: pos.epic,
              });
              this.clearModifyReject(pos);
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
              exit_reason: exitHit.reason,
              detail: closeRes.detail || 'ema_tick_close_failed',
            });
          }
        }
      }

      // VS-System multi-TP ladder (app-managed) before single Reader partial
      // Capital LIVE: refuse scale-outs while venue UPL unread (same as soft exits)
      if (
        allowClose &&
        capitalUplReady &&
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
        capitalUplReady &&
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
              const { exit: fill, fill_proven } = resolveCloseExitFill({
                fill_price: closeRes.fill_price,
                mark,
                entry: pos.entry,
                capitalLive,
              });
              const rem =
                closeRes.remaining_size != null && Number.isFinite(closeRes.remaining_size)
                  ? Number(closeRes.remaining_size)
                  : Math.max(0, pos.size - partial.close_size);
              // Flat after a partial request = broker full-closed (Check- / dust) —
              // journal the entire position size, not just the requested slice.
              const closedVol =
                rem <= 1e-9 ? pos.size : Math.max(0, pos.size - rem);
              const priced = priceResolvedCloseMoney({
                ...resolveCloseMoneyPnl({
                side: pos.side,
                entry: pos.entry,
                fill,
                size: closedVol,
                value_per_point_per_lot: pv,
                fill_pnl: preferCloseFillPnl({
                  fill_pnl: closeRes.fill_pnl,
                  broker_upl: pos.broker_upl,
                  size_ratio: pos.size > 0 ? closedVol / pos.size : 1,
                }),
                capitalLive,
                }),
                volume: closedVol,
              });
              const outcome: TradeOutcome = {
                position_id: pos.position_id,
                side: pos.side,
                entry: pos.entry,
                exit: fill,
                volume: closedVol,
                pnl: priced.pnl,
                fees: priced.fees,
                pnl_proven: priced.pnl_proven,
                slippage: fill_proven ? Math.abs(fill - quote.mid) : 0,
                mae: pos.mae,
                mfe: pos.mfe,
                r_multiple: 0,
                hold_ms: heldMs,
                exit_reason: capitalCloseExitReason(
                  rem <= 1e-9 && closedVol > partial.close_size + 1e-9
                    ? `${partial.reason}_FULL`
                    : partial.reason,
                  priced.pnl_proven
                ),
              };
              pipeline.recordTradeClose(pos.opportunity_id, pos.decision, outcome, {
                epic: pos.epic,
              });
              if (rem > 1e-9) {
                pos.size = rem;
                pos.partial_close_applied = true;
                closed.push({ position: { ...pos }, outcome, reason: outcome.exit_reason });
                continue;
              }
              this.open.delete(pos.position_id);
              closed.push({ position: pos, outcome, reason: outcome.exit_reason });
              continue;
            }
            // Partial failed — fall through to full manage (do not mark applied)
          }
        }
      }

      // Hard protective fills before soft BestOutcome / TIME_STOP
      const protective = protectiveExit(pos, quote);

      // Capital LIVE: BestOutcome is mark-path — refuse while venue UPL unread
      // (STOP_HIT / TP_HIT / TIME_STOP still fire).
      let verdict =
        protective ??
        (maxHold > 0 && heldMs >= maxHold
          ? {
              exit: true,
              reason: `TIME_STOP · held ${Math.round(heldMs / 1000)}s ≥ ${Math.round(maxHold / 1000)}s`,
            }
          : capitalUplReady
            ? decideBestOutcomeExit(
                {
                  open_side: pos.side,
                  entry_price: pos.entry,
                  entry_at: pos.entry_at,
                  mfe: pos.mfe,
                  mae: pos.mae,
                  peak_retention,
                  regime: toDeskRegime(
                    input.live_regime || pos.decision.analysis.regime,
                    pos.decision.analysis
                  ),
                  playbook:
                    pos.playbook_at_entry ??
                    mapRegimeToPlaybook(pos.regime_at_entry, pos.decision.analysis),
                  entry_setup: pos.entry_setup ?? 'CONTINUATION',
                },
                mark
              )
            : { exit: false, reason: '' });

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
        if (ema3 != null) {
          await this.maybeEma3Trail(broker, pos, quote, {
            ema3,
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
        if (ema3 != null) {
          await this.maybeEma3Trail(broker, pos, quote, {
            ema3,
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

      const hardReason = protective?.reason ?? null;
      const { exit, fill_proven } = resolveCloseExitFill({
        fill_price: closeRes.fill_price,
        mark,
        entry: pos.entry,
        capitalLive,
        hard_reason: hardReason,
        stop_loss: pos.stop_loss,
        take_profit: pos.take_profit,
      });
      const priced = priceResolvedCloseMoney({
        ...resolveCloseMoneyPnl({
        side: pos.side,
        entry: pos.entry,
        fill: exit,
        size: pos.size,
        value_per_point_per_lot: pv,
        fill_pnl: preferCloseFillPnl({
          fill_pnl: closeRes.fill_pnl,
          broker_upl: pos.broker_upl,
        }),
        capitalLive,
        }),
        volume: pos.size,
      });
      const pnlPts = priced.pnl_pts;
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
        pnl: priced.pnl,
        fees: priced.fees,
            pnl_proven: priced.pnl_proven,
        slippage: fill_proven ? Math.abs(exit - quote.mid) : 0,
        mae: pos.mae,
        mfe: pos.mfe,
        r_multiple: pnlPts / riskDist,
        hold_ms: heldMs,
        exit_reason: capitalCloseExitReason(verdict.reason, priced.pnl_proven),
      };

      pipeline.recordTradeClose(pos.opportunity_id, pos.decision, outcome, {
        epic: pos.epic,
      });
      this.open.delete(pos.position_id);
      closed.push({ position: pos, outcome, reason: outcome.exit_reason });
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
    const capitalLive = broker.name === 'CAPITAL' && !broker.paper;
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

      const { exit: fill, fill_proven } = resolveCloseExitFill({
        fill_price: closeRes.fill_price,
        mark,
        entry: pos.entry,
        capitalLive,
        hard_reason: 'TP_HIT',
        take_profit: level.price,
      });
      const rem =
        closeRes.remaining_size != null && Number.isFinite(closeRes.remaining_size)
          ? Number(closeRes.remaining_size)
          : isFinal
            ? 0
            : Math.max(0, pos.size - closeSize);
      // Intermediate that went flat (Check- full-lot / dust) → credit full size
      const vol =
        isFinal || rem <= 1e-9
          ? pos.size
          : Math.max(0, pos.size - rem);
      const priced = priceResolvedCloseMoney({
        ...resolveCloseMoneyPnl({
        side: pos.side,
        entry: pos.entry,
        fill,
        size: vol,
        value_per_point_per_lot: pv,
        fill_pnl: preferCloseFillPnl({
          fill_pnl: closeRes.fill_pnl,
          broker_upl: pos.broker_upl,
          size_ratio: pos.size > 0 ? vol / pos.size : 1,
        }),
        capitalLive,
        }),
        volume: vol,
      });
      const outcome: TradeOutcome = {
        position_id: pos.position_id,
        side: pos.side,
        entry: pos.entry,
        exit: fill,
        volume: vol,
        pnl: priced.pnl,
        fees: priced.fees,
        pnl_proven: priced.pnl_proven,
        slippage: fill_proven ? Math.abs(fill - quote.mid) : 0,
        mae: pos.mae,
        mfe: pos.mfe,
        r_multiple: 0,
        hold_ms: heldMs,
        exit_reason: capitalCloseExitReason(
          `MULTI_TP_${level.index}${
            isFinal || rem <= 1e-9 ? '_FINAL' : ''
          }`,
          priced.pnl_proven
        ),
      };
      pipeline.recordTradeClose(pos.opportunity_id, pos.decision, outcome, {
        epic: pos.epic,
      });
      level.status = 'EXECUTED';
      closed.push({ position: { ...pos }, outcome, reason: outcome.exit_reason });

      if (isFinal || rem <= 1e-9) {
        this.open.delete(pos.position_id);
        return { handled: true, removed: true, closed, close_failed };
      }

      pos.size = rem;
      pos.partial_close_applied = true;
    }

    return { handled: any, removed: false, closed, close_failed };
  }

  /**
   * Broker MODIFY + unified trade event journal (Reader OPEN/MODIFY/CLOSE stream).
   */
  private async brokerModify(
    broker: MasterBroker,
    pos: ManagedPosition,
    patch: {
      stop_level?: number;
      profit_level?: number;
      stop_distance?: number;
      trailing_stop?: boolean;
    },
    reason: string
  ): Promise<{ ok: boolean; detail?: string; order_id?: string | null }> {
    if (!broker.modifyPosition) return { ok: false, detail: 'no_modify' };
    // Pass only the patched legs. MT4 preserves omitted SL/TP from live status
    // (local prefill would bypass that and rewrite chart from stale managed state).
    // Capital/Paper only apply provided fields.
    const mod = await broker.modifyPosition({
      position_id: pos.position_id,
      stop_level: patch.stop_level,
      profit_level: patch.profit_level,
      stop_distance: patch.stop_distance,
      trailing_stop: patch.trailing_stop,
      require_trail_off:
        !!pos.native_trail_armed &&
        patch.stop_level != null &&
        Number.isFinite(patch.stop_level) &&
        patch.trailing_stop !== true,
    });
    logTradeEvent({
      event: 'MODIFY',
      broker: broker.name,
      epic: pos.epic,
      side: pos.side,
      volume: pos.size,
      price:
        patch.stop_level ??
        patch.profit_level ??
        (patch.stop_distance != null ? patch.stop_distance : null),
      position_id: pos.position_id,
      intent_id: pos.intent_id,
      opportunity_id: pos.opportunity_id,
      ok: !!mod.ok,
      detail: `${reason}${mod.detail ? `:${mod.detail}` : ''}`,
    });
    // Absolute SL (BE/scalp/EMA trail) proved off native trail — clear local arm flag
    if (
      mod.ok &&
      patch.stop_level != null &&
      Number.isFinite(patch.stop_level) &&
      patch.trailing_stop !== true
    ) {
      pos.native_trail_armed = false;
    }
    return mod;
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

    if (this.shouldSkipModifyLevel(pos, clamped)) {
      return false;
    }

    const mod = await this.brokerModify(
      broker,
      pos,
      { stop_level: clamped },
      'protective_stop'
    );
    if (mod.ok) {
      pos.stop_loss = clamped;
      this.clearModifyReject(pos);
      return true;
    }
    await this.noteModifyReject(pos, clamped, mod.detail || '');
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
        const presentOnly =
          !match && (listed.presence_ids ?? []).includes(pos.position_id);
        // Presence-only = still live (level-less); treat as found with unknown SL
        // so soft close stays fail-closed until chart stop is visible.
        brokerFound = match ? true : presentOnly ? true : false;
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

    // Prefer OPEN structure levels before soft 10% cushion. Soft attach after a
    // failed intended MODIFY would paint chart SL and stop sync from retrying.
    const wantSl =
      pos.intended_stop_loss != null &&
      Number.isFinite(pos.intended_stop_loss) &&
      pos.intended_stop_loss > 0
        ? Number(pos.intended_stop_loss)
        : null;
    const wantTp =
      pos.intended_take_profit != null &&
      Number.isFinite(pos.intended_take_profit) &&
      pos.intended_take_profit > 0
        ? Number(pos.intended_take_profit)
        : null;
    if (wantSl != null || wantTp != null) {
      const patch: { stop_level?: number; profit_level?: number } = {};
      if (wantSl != null) patch.stop_level = wantSl;
      if (wantTp != null) patch.profit_level = wantTp;
      const intended = await this.brokerModify(
        broker,
        pos,
        patch,
        'intended_naked_recovery'
      );
      if (intended.ok) {
        if (wantSl != null) pos.stop_loss = wantSl;
        if (wantTp != null) pos.take_profit = wantTp;
        this.clearModifyReject(pos);
        if (pos.stop_loss != null) {
          this.nakedRecoveryLevel.delete(pos.position_id);
          pos.naked_recovery_level = null;
          return;
        }
        // TP-only intended attached — still naked SL → soft cushion below
      } else if (wantSl != null) {
        // Failed structure SL: do not soft-attach on the *first* reject (keeps
        // sync/manage free to retry intended). After escalate (level≥1), fall
        // through to soft cushion / native trail so chart is not permanently naked
        // with close_requires_sl blocking exits.
        await this.noteModifyReject(
          pos,
          wantSl,
          intended.detail || ''
        );
        const esc =
          this.nakedRecoveryLevel.get(pos.position_id) ??
          (pos.naked_recovery_level != null && Number.isFinite(pos.naked_recovery_level)
            ? Math.max(0, Math.floor(Number(pos.naked_recovery_level)))
            : 0);
        if (esc < 1) {
          this.nakedRecoveryLevel.set(pos.position_id, 1);
          pos.naked_recovery_level = 1;
          return;
        }
        // Fall through to soft / native escalate
      }
      // TP-only intended failed — still allow soft SL cushion
    }

    const mark = protectiveMark(pos.side, quote);
    const level =
      this.nakedRecoveryLevel.get(pos.position_id) ??
      (pos.naked_recovery_level != null && Number.isFinite(pos.naked_recovery_level)
        ? Math.max(0, Math.floor(Number(pos.naked_recovery_level)))
        : 0);
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

    const mod = await this.brokerModify(
      broker,
      pos,
      { stop_level: recovery },
      'naked_recovery'
    );
    if (mod.ok) {
      pos.stop_loss = recovery;
      this.clearModifyReject(pos);
      this.nakedRecoveryLevel.delete(pos.position_id);
      pos.naked_recovery_level = null;
      return;
    }
    // VS-System: after first widen fails, try Capital native trailingStop while still naked
    // (flat/loss) so chart gets *some* protection when stopLevel keeps rejecting.
    // MT4 EA has no native trail — skip (would only re-ACK same SL/TP).
    if (level >= 1 && broker.supportsNativeTrailingStop) {
      const minD = effectiveMinStopDistance(pos.epic, minStopDist);
      const native = await this.brokerModify(
        broker,
        pos,
        { trailing_stop: true, stop_distance: minD },
        'naked_native_trail'
      );
      if (native.ok) {
        pos.native_trail_armed = true;
        const guess = pos.side === 'BUY' ? mark - minD : mark + minD;
        if (Number.isFinite(guess)) pos.stop_loss = guess;
        this.clearModifyReject(pos);
        this.nakedRecoveryLevel.delete(pos.position_id);
        pos.naked_recovery_level = null;
        return;
      }
    }
    const nextLevel = level + 1;
    this.nakedRecoveryLevel.set(pos.position_id, nextLevel);
    pos.naked_recovery_level = nextLevel;
    await this.noteModifyReject(pos, recovery, mod.detail || '');
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
    // Capital-only — MT4 OrderModify has no trailingStop; ACK would falsely arm.
    if (!broker.supportsNativeTrailingStop) return;
    const mark = protectiveMark(pos.side, quote);
    const fav = favorableMove(pos.side, pos.entry, mark);
    const minD = effectiveMinStopDistance(pos.epic, opts.min_stop_distance);
    // Need clear profit beyond min-stop before asking Capital for native trail
    if (!(fav > minD * 1.5)) return;

    const dist = Math.max(minD, fav * opts.lockPct);
    const mod = await this.brokerModify(
      broker,
      pos,
      { trailing_stop: true, stop_distance: dist },
      'native_trail'
    );
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
    const last = pos.scalp_chase_at_ms ?? 0;
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
        minBump: scalpMinStopImprovement(pos.epic),
      })
    ) {
      return;
    }

    // Time-gate all chase during backoff; never retry identical rejected level
    if (this.shouldSkipModifyLevel(pos, candidate, { timeGateAll: true })) {
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
        minBump: scalpMinStopImprovement(pos.epic),
      })
    ) {
      return;
    }
    if (this.shouldSkipModifyLevel(pos, stop, { timeGateAll: true })) {
      return;
    }

    pos.scalp_chase_at_ms = now;
    const mod = await this.brokerModify(
      broker,
      pos,
      { stop_level: stop },
      'scalp_chase'
    );
    if (mod.ok) {
      pos.stop_loss = stop;
      this.clearModifyReject(pos);
      return;
    }
    await this.noteModifyReject(pos, stop, mod.detail || '');
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
    const capitalLive = broker.name === 'CAPITAL' && !broker.paper;
    // Parity with soft-trail: money-BE must not arm on mark profit while UPL unread/zero
    const capitalUplReady =
      !capitalLive || usableBrokerUpl(pos.broker_upl) != null;
    const money = resolveFloatingMoneyPnl({
      side: pos.side,
      entry: pos.entry,
      mark,
      size: pos.size,
      value_per_point_per_lot: opts.pointValue ?? 1,
      broker_upl: pos.broker_upl,
      capitalLive,
    });

    let armed = false;
    if (moneyNeed > 0 && capitalUplReady && money >= moneyNeed) armed = true;
    // Capital LIVE: geometry BE (be_start / progress) also needs venue UPL —
    // mark profit alone must not lock SL while the book is unread.
    if (!armed && capitalUplReady && beStart > 0) armed = fav >= beStart;
    if (!armed && capitalUplReady && progressNeed > 0 && pos.take_profit != null) {
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

    if (this.shouldSkipModifyLevel(pos, be)) {
      return;
    }
    const mod = await this.brokerModify(
      broker,
      pos,
      { stop_level: be },
      'breakeven'
    );
    if (mod.ok) {
      pos.stop_loss = be;
      this.clearModifyReject(pos);
      return;
    }
    await this.noteModifyReject(pos, be, mod.detail || '');
  }

  /**
   * VS-System EMA3 trail — tighten SL toward EMA(3) of closes.
   * Never places SL on the wrong side of mark (instant stop / Capital reject).
   */
  private async maybeEma3Trail(
    broker: MasterBroker,
    pos: ManagedPosition,
    quote: Quote,
    opts: { ema3: number; min_stop_distance?: number | null }
  ): Promise<void> {
    if (!broker.modifyPosition) return;
    const ema3 = opts.ema3;
    if (!(ema3 > 0) || !Number.isFinite(ema3)) return;
    const mark = protectiveMark(pos.side, quote);
    let next: number | null = null;
    if (pos.side === 'BUY') {
      // Only move SL up toward EMA3; never at/through mark
      if (ema3 < mark && (pos.stop_loss == null || ema3 > pos.stop_loss)) {
        next = ema3;
      }
    } else {
      if (ema3 > mark && (pos.stop_loss == null || ema3 < pos.stop_loss)) {
        next = ema3;
      }
    }
    if (next == null) return;
    if (this.shouldSkipModifyLevel(pos, next)) return;
    const mod = await this.brokerModify(
      broker,
      pos,
      { stop_level: next },
      'ema3_trail'
    );
    if (mod.ok) {
      pos.stop_loss = next;
      this.clearModifyReject(pos);
    } else {
      await this.noteModifyReject(pos, next, mod.detail || '');
    }
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
      /** false = provisional mid — must not overwrite proven entry */
      open_level_proven?: boolean;
      stop_level?: number | null;
      profit_level?: number | null;
      upl?: number | null;
      opened_at?: string | null;
    }>,
    opts?: { retainIds?: Set<string> }
  ): { external_partials: ExternalPartialEvent[] } {
    const external_partials: ExternalPartialEvent[] = [];
    const brokerIds = new Set(brokerPositions.map((p) => p.position_id));
    const retain = opts?.retainIds;
    for (const id of [...this.open.keys()]) {
      if (!brokerIds.has(id) && !retain?.has(id)) this.open.delete(id);
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
        // Null / <=0 broker SL|TP clears local so naked recovery / UI stay honest
        // (Check-: OrderStopLoss()/TakeProfit()=0 means no level).
        existing.stop_loss =
          bp.stop_level != null &&
          Number.isFinite(bp.stop_level) &&
          bp.stop_level > 0
            ? bp.stop_level
            : null;
        existing.take_profit =
          bp.profit_level != null &&
          Number.isFinite(bp.profit_level) &&
          bp.profit_level > 0
            ? bp.profit_level
            : null;
        if (bp.size > 0) existing.size = bp.size;
        // Chart/broker symbol is truth — desk GOLD alias must not stick after XAUUSD fill
        if (bp.epic && String(bp.epic).trim()) {
          existing.epic = String(bp.epic).trim();
        }
        // Refresh entry from venue-proven open_level only — provisional mid must
        // not stomp a proven OPEN fill (Capital level-less list rows).
        if (
          bp.open_level_proven !== false &&
          bp.open_level != null &&
          Number.isFinite(bp.open_level) &&
          bp.open_level > 0
        ) {
          existing.entry = bp.open_level;
        }
        if (bp.upl !== undefined) {
          existing.broker_upl =
            bp.upl != null && Number.isFinite(bp.upl) ? Number(bp.upl) : null;
        }
        // Venue side is truth — fix local invent / bad adopt so protective marks match
        if (
          (bp.side === 'BUY' || bp.side === 'SELL') &&
          existing.side !== bp.side
        ) {
          existing.side = bp.side;
          if (existing.decision) {
            existing.decision = {
              ...existing.decision,
              side: bp.side,
              kind: bp.side,
            };
          }
        }
        continue;
      }
      // Orphan broker position — adopt only with venue-proven entry (never provisional mid)
      if (
        bp.open_level_proven === false ||
        !(bp.open_level > 0) ||
        !Number.isFinite(bp.open_level)
      ) {
        continue;
      }
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
        intended_stop_loss:
          bp.stop_level != null &&
          Number.isFinite(bp.stop_level) &&
          bp.stop_level > 0
            ? bp.stop_level
            : null,
        intended_take_profit:
          bp.profit_level != null &&
          Number.isFinite(bp.profit_level) &&
          bp.profit_level > 0
            ? bp.profit_level
            : null,
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
        playbook_at_entry: 'SCALP',
        entry_setup: 'CONTINUATION',
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

/**
 * Map MASTER coarse/directional regime → desk RegimeName so
 * thesisFailureForPlaybook / playbookFromRegime match.
 */
export function toDeskRegime(
  regime: string,
  analysis?: { trend_dir?: string; structure_bias?: string } | null
): string {
  const r = String(regime || '').trim().toUpperCase();
  if (r === 'TREND') {
    if (analysis?.trend_dir === 'DOWN' || analysis?.structure_bias === 'BEARISH') {
      return 'TREND_DOWN';
    }
    return 'TREND_UP';
  }
  if (r === 'BREAKOUT') {
    if (analysis?.trend_dir === 'DOWN' || analysis?.structure_bias === 'BEARISH') {
      return 'BREAKOUT_DOWN';
    }
    return 'BREAKOUT_UP';
  }
  if (r === 'HIGH_VOLATILITY') return 'EXPANSION';
  if (r === 'LOW_VOLATILITY') return 'COMPRESSION';
  if (r === 'UNSTABLE' || r === 'UNKNOWN' || !r) return 'RANGE';
  return r;
}

/** Desk playbook from MASTER/desk regime labels (RANGE → FADE). */
export function mapRegimeToPlaybook(
  regime: string,
  analysis?: { trend_dir?: string; structure_bias?: string } | null
): 'LONG' | 'SCALP' | 'FADE' {
  const book = playbookFromRegime(toDeskRegime(regime, analysis));
  if (book === 'WAIT') return 'SCALP';
  return book;
}

/** Floating UPL across open positions using protective marks + broker UPL when known. */
export function floatingUnrealizedPnl(
  positions: Array<
    Pick<ManagedPosition, 'side' | 'entry' | 'size' | 'broker_upl'>
  >,
  quote: Quote,
  pointValue = 1,
  capitalLive = false
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
      capitalLive,
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
