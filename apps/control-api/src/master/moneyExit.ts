/**
 * VS-System money PnL + soft-trail helpers for SCALPING-style exits.
 */

import { instrumentPipSize, stopValidVsMark } from './capitalStop.js';

/** Price-path floating PnL in account currency (pts × lots × value/point). */
export function instrumentMoneyPnl(input: {
  side: 'BUY' | 'SELL';
  entry: number;
  mark: number;
  size: number;
  value_per_point_per_lot: number;
}): number {
  const pts =
    input.side === 'BUY' ? input.mark - input.entry : input.entry - input.mark;
  return pts * input.size * input.value_per_point_per_lot;
}

/**
 * Prefer computed money when broker UPL is stale/zero while price is in profit
 * (paper / mark-model arms). Capital LIVE: never invent mark profit over
 * missing/zero venue UPL — money soft-trail / close-all must use broker UPL.
 */
export function resolveFloatingMoneyPnl(input: {
  side: 'BUY' | 'SELL';
  entry: number;
  mark: number;
  size: number;
  value_per_point_per_lot: number;
  broker_upl?: number | null;
  /** Capital LIVE: trust venue UPL only; refuse mark profit when UPL missing */
  capitalLive?: boolean;
}): number {
  const computed = instrumentMoneyPnl(input);
  const broker = input.broker_upl;
  if (input.capitalLive) {
    const usable = usableBrokerUpl(broker);
    if (usable != null) return usable;
    return 0;
  }
  if (broker == null || !Number.isFinite(broker)) return computed;
  if (broker <= 0 && computed > 0) return computed;
  if (computed > 0 || broker > 0) return Math.max(broker, computed);
  return broker;
}

/**
 * Prefer Capital confirm.profit (account currency) when the broker returns it.
 * Falls back to price-path money PnL when confirm profit is absent — except on
 * Capital LIVE, where inventing pts×size would fail-open daily-loss / streak.
 *
 * Floating UPL of exactly 0 is often stale — callers must not pass it as
 * fill_pnl unless it came from a real close confirm (see usableBrokerUpl).
 */
export function resolveCloseMoneyPnl(input: {
  side: 'BUY' | 'SELL';
  entry: number;
  fill: number;
  size: number;
  value_per_point_per_lot: number;
  fill_pnl?: number | null;
  /** Capital LIVE: refuse mark/SL geometry as realized money when fill_pnl missing */
  capitalLive?: boolean;
}): {
  pnl: number;
  pnl_pts: number;
  from_broker: boolean;
  /** false = do not update daily_pnl / consecutive_losses */
  pnl_proven: boolean;
} {
  const pnl_pts =
    input.side === 'BUY' ? input.fill - input.entry : input.entry - input.fill;
  if (input.fill_pnl != null && Number.isFinite(input.fill_pnl)) {
    return {
      pnl: Number(input.fill_pnl),
      pnl_pts,
      from_broker: true,
      pnl_proven: true,
    };
  }
  if (input.capitalLive) {
    return { pnl: 0, pnl_pts, from_broker: false, pnl_proven: false };
  }
  return {
    pnl: pnl_pts * input.size * input.value_per_point_per_lot,
    pnl_pts,
    from_broker: false,
    pnl_proven: true,
  };
}

/**
 * Tag Capital LIVE closes whose money is unproven so trade cards / journal
 * never look like a flat £0 proven exit.
 */
export function capitalCloseExitReason(
  base: string,
  pnl_proven: boolean
): string {
  if (pnl_proven) return base;
  if (/capital_close_pnl_unproven/i.test(base)) return base;
  return `${base} · capital_close_pnl_unproven`;
}

/**
 * Apply model fees after resolveCloseMoneyPnl. Unproven Capital closes stay 0/0.
 */
export function priceResolvedCloseMoney(input: {
  pnl: number;
  pnl_pts: number;
  from_broker: boolean;
  pnl_proven: boolean;
  volume: number;
}): {
  pnl: number;
  pnl_pts: number;
  from_broker: boolean;
  pnl_proven: boolean;
  fees: number;
} {
  if (!input.pnl_proven) {
    return {
      pnl: 0,
      pnl_pts: input.pnl_pts,
      from_broker: false,
      pnl_proven: false,
      fees: 0,
    };
  }
  const priced = applyCloseFees({
    pnl: input.pnl,
    volume: input.volume,
    from_broker: input.from_broker,
  });
  return {
    pnl: priced.pnl,
    pnl_pts: input.pnl_pts,
    from_broker: input.from_broker,
    pnl_proven: true,
    fees: priced.fees,
  };
}

/**
 * Use floating/orphan broker UPL as realized only when non-zero.
 * Zero is treated as missing so mark PnL + model fees can run.
 * Real close confirms that return 0 should be passed via fill_pnl directly.
 */
export function usableBrokerUpl(upl: number | null | undefined): number | null {
  if (upl == null || !Number.isFinite(upl) || upl === 0) return null;
  return Number(upl);
}

/**
 * Prefer DELETED/confirm profit; else last synced non-zero broker UPL.
 * Partial closes scale UPL by closed/full size when confirm profit is absent.
 */
export function preferCloseFillPnl(input: {
  fill_pnl?: number | null;
  broker_upl?: number | null;
  /** closed_size / full_size; default 1 (full close) */
  size_ratio?: number;
}): number | null {
  if (input.fill_pnl != null && Number.isFinite(input.fill_pnl)) {
    return Number(input.fill_pnl);
  }
  const upl = usableBrokerUpl(input.broker_upl);
  if (upl == null) return null;
  const ratio =
    input.size_ratio != null &&
    Number.isFinite(input.size_ratio) &&
    input.size_ratio > 0
      ? Math.min(1, Number(input.size_ratio))
      : 1;
  if (ratio >= 1 - 1e-12) return upl;
  return upl * ratio;
}

/**
 * Resolve journal exit price after CLOSE.
 * Capital LIVE: never forge live bid/ask as fill — prefer confirm fill, then
 * hard STOP/TP level, else entry placeholder (PnL from fill_pnl when present).
 */
export function resolveCloseExitFill(input: {
  fill_price?: number | null;
  mark: number;
  entry: number;
  capitalLive: boolean;
  hard_reason?: string | null;
  stop_loss?: number | null;
  take_profit?: number | null;
}): { exit: number; fill_proven: boolean } {
  if (
    input.fill_price != null &&
    Number.isFinite(input.fill_price) &&
    input.fill_price > 0
  ) {
    return { exit: Number(input.fill_price), fill_proven: true };
  }
  if (input.capitalLive) {
    // Local SL/TP are managed geometry — useful exit proxy, NOT venue-proven fill
    if (
      input.hard_reason === 'STOP_HIT' &&
      input.stop_loss != null &&
      Number.isFinite(input.stop_loss) &&
      input.stop_loss > 0
    ) {
      return { exit: Number(input.stop_loss), fill_proven: false };
    }
    if (
      input.hard_reason === 'TP_HIT' &&
      input.take_profit != null &&
      Number.isFinite(input.take_profit) &&
      input.take_profit > 0
    ) {
      return { exit: Number(input.take_profit), fill_proven: false };
    }
    return { exit: input.entry, fill_proven: false };
  }
  return { exit: input.mark, fill_proven: false };
}

/** Round-trip commission model (replay default 0.05 / lot). Override via MASTER_COMMISSION_PER_LOT. */
export function estimateTradeFees(volume: number): number {
  const raw = Number(process.env.MASTER_COMMISSION_PER_LOT ?? 0.05);
  const perLot = Number.isFinite(raw) && raw >= 0 ? raw : 0.05;
  const v = Number(volume);
  if (!(v > 0) || !(perLot > 0)) return 0;
  return perLot * v;
}

/**
 * Apply model commission when PnL is mark-computed.
 * Broker fill_pnl is treated as already net — pnl is not reduced again, but
 * estimated fees are still recorded for dashboard total_fees / KPI honesty.
 */
export function applyCloseFees(input: {
  pnl: number;
  volume: number;
  from_broker?: boolean;
}): { pnl: number; fees: number } {
  const fees = estimateTradeFees(input.volume);
  if (input.from_broker) {
    return { pnl: input.pnl, fees };
  }
  return { pnl: input.pnl - fees, fees };
}

/** Soft trail distance in price units (pip × count) — never floored to Capital min-stop. */
export function softTrailDistancePrice(symbol: string, pips = 0.3): number {
  const pip = instrumentPipSize(symbol);
  const n = Number(pips);
  const count = Number.isFinite(n) && n > 0 ? n : 0.3;
  return pip * count;
}

/**
 * Capital-safe BE stop that DEFERs (null) when ideal lock is illegal vs mark.
 * Never clamps BE below entry (BUY) / above entry (SELL) — that would fake a lock.
 */
export function capitalSafeBreakEvenStop(input: {
  side: 'BUY' | 'SELL';
  entry: number;
  mark: number;
  symbol: string;
  offset?: number;
  current_stop?: number | null;
  min_distance?: number | null;
}): number | null {
  const off = Math.max(0, input.offset ?? 0);
  const ideal =
    input.side === 'BUY' ? input.entry + off : input.entry - off;
  if (
    !stopValidVsMark({
      side: input.side,
      stop: ideal,
      mark: input.mark,
      symbol: input.symbol,
      min_distance: input.min_distance,
    })
  ) {
    return null;
  }
  const cur = input.current_stop;
  const tighter =
    cur == null
      ? true
      : input.side === 'BUY'
        ? ideal > cur
        : ideal < cur;
  if (!tighter) return null;
  return ideal;
}

/**
 * Soft-trail arm gate — VS-System 10s SCALPING only.
 * Requires scalp manage (`scalp_enabled`) plus money PnL ≥ arm (or already armed).
 */
export function decideSoftTrailArm(input: {
  money_pnl: number;
  money_arm: number;
  already_armed: boolean;
  /** VS-System SCALPING manage — soft trail must not run on structure/MFE modes. */
  scalp_enabled?: boolean;
}): {
  run: boolean;
  reason:
    | 'off'
    | 'not_scalping'
    | 'below_money_arm'
    | 'profit_hit'
    | 'already_armed';
} {
  if (!(input.money_arm > 0)) return { run: false, reason: 'off' };
  if (input.scalp_enabled === false) return { run: false, reason: 'not_scalping' };
  if (input.already_armed) return { run: true, reason: 'already_armed' };
  if (Number.isFinite(input.money_pnl) && input.money_pnl >= input.money_arm) {
    return { run: true, reason: 'profit_hit' };
  }
  return { run: false, reason: 'below_money_arm' };
}

/** Update peak watermark once soft trail is armed. */
export function updateSoftTrailPeak(
  side: 'BUY' | 'SELL',
  mark: number,
  peak: number | null | undefined
): number {
  if (peak == null || !Number.isFinite(peak)) return mark;
  return side === 'BUY' ? Math.max(peak, mark) : Math.min(peak, mark);
}

/** Soft exit level from peak −/+ soft distance. */
export function softTrailExitLevel(
  side: 'BUY' | 'SELL',
  peak: number,
  distance: number
): number {
  return side === 'BUY' ? peak - distance : peak + distance;
}

export function softTrailExitHit(
  side: 'BUY' | 'SELL',
  mark: number,
  exitLevel: number
): boolean {
  return side === 'BUY' ? mark <= exitLevel : mark >= exitLevel;
}

/**
 * Check- portfolio close-all on floating book PnL.
 * Shared by live PositionManager + replay so AUTO_* reasons stay aligned.
 */
export function decidePortfolioCloseAll(input: {
  float_pnl: number;
  close_all_profit?: number;
  close_all_loss?: number;
}): { close: boolean; reason: string } {
  const profit = Math.max(0, Number(input.close_all_profit) || 0);
  const loss = Math.max(0, Number(input.close_all_loss) || 0);
  const pnl = Number(input.float_pnl);
  if (!Number.isFinite(pnl)) return { close: false, reason: '' };
  if (profit > 0 && pnl >= profit) {
    return { close: true, reason: `AUTO_PROFIT_${pnl.toFixed(2)}` };
  }
  if (loss > 0 && pnl <= -loss) {
    return { close: true, reason: `AUTO_LOSS_${pnl.toFixed(2)}` };
  }
  return { close: false, reason: '' };
}
