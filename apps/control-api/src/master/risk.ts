/** Risk engine — can BLOCK any decision. Equity-based sizing required for production volume. */
import { clampSizeForBuyingPower } from './capitalSize.js';
import { validateSlTp } from './slTp.js';
import type {
  AccountSnapshot,
  InstrumentSpec,
  MasterConfig,
  MasterDecision,
  Quote,
  RiskVerdict,
  TradeCandidate,
} from './types.js';

export function evaluateRisk(
  decision: MasterDecision,
  account: AccountSnapshot,
  instrument: InstrumentSpec,
  quote: Quote,
  cfg: MasterConfig,
  opts?: { last_loss_ms?: number; now_ms?: number; symbol_open?: number; epic?: string }
): RiskVerdict {
  const reasons: string[] = [];
  const now = opts?.now_ms ?? Date.now();

  if (cfg.kill_switch) reasons.push('kill_switch');
  if (decision.kind === 'WAIT' || decision.kind === 'BLOCK' || !decision.side) {
    return { allowed: false, volume: 0, risk_amount: 0, reasons: ['no_trade_decision'] };
  }
  if (account.equity <= 0) reasons.push('equity_non_positive');
  if (account.open_positions >= cfg.max_open_positions) reasons.push('max_open_positions');
  if ((opts?.symbol_open ?? 0) >= cfg.max_symbol_positions) reasons.push('max_symbol_exposure');

  const dd =
    account.peak_equity > 0
      ? (account.peak_equity - account.equity) / account.peak_equity
      : 0;
  if (dd >= cfg.max_drawdown_pct) reasons.push('max_drawdown');

  const dailyLossPct =
    (account.day_start_equity ?? account.equity) > 0
      ? Math.max(0, -account.daily_pnl) / (account.day_start_equity ?? account.equity)
      : 0;
  if (dailyLossPct >= cfg.max_daily_loss_pct) reasons.push('max_daily_loss');

  if (account.consecutive_losses >= cfg.consecutive_loss_limit) {
    reasons.push('consecutive_loss_protection');
  }

  // Check- hard $ profit lock / equity floor / daily loss (0 = disabled)
  // Check uses equity − day_start_equity (floating included) for $ gates
  const equityDaily =
    account.day_start_equity != null &&
    Number.isFinite(account.day_start_equity) &&
    account.day_start_equity > 0
      ? account.equity - account.day_start_equity
      : account.daily_pnl;
  if (cfg.profit_lock > 0 && equityDaily >= cfg.profit_lock) {
    reasons.push('profit_lock');
  }
  if (cfg.equity_floor > 0 && account.equity <= cfg.equity_floor) {
    reasons.push('equity_floor');
  }
  if (cfg.daily_loss_limit > 0 && equityDaily <= -cfg.daily_loss_limit) {
    reasons.push('daily_loss_limit');
  }

  // Reader/Check- account not tradeable
  if (account.trade_allowed === false) {
    reasons.push('account_not_tradeable');
  }

  if (quote.spread > cfg.max_spread_abs) reasons.push('spread_protection');
  if (now - quote.ts_ms > cfg.stale_quote_ms) reasons.push('stale_data_protection');

  if (
    opts?.last_loss_ms &&
    now - opts.last_loss_ms < cfg.cooldown_ms_after_loss
  ) {
    reasons.push('cooldown_after_loss');
  }

  const cand = decision.side === 'BUY' ? decision.buy : decision.sell;
  // Reader validate_sl_tp before sizing
  const slTp = validateSlTp({
    side: decision.side,
    entry: cand.entry,
    stop_loss: cand.stop_loss,
    take_profit: cand.take_profit,
    swing_low: decision.analysis?.swing_low,
    swing_high: decision.analysis?.swing_high,
    pip: instrument.point,
    max_stop_loss_pips: cfg.max_stop_loss_pips,
  });
  if (!slTp.allowed) reasons.push(slTp.reason || 'invalid_sl_tp');

  const sizing = sizeFromEquity(account.equity, cand, instrument, cfg, {
    consecutive_losses: account.consecutive_losses,
  });
  if (!sizing.allowed) reasons.push(...sizing.reasons);

  if (reasons.length) {
    return { allowed: false, volume: 0, risk_amount: 0, reasons };
  }

  let volume = sizing.volume;
  const notes: string[] = [...sizing.reasons];
  const clamped = clampSizeForBuyingPower({
    epic: opts?.epic || instrument.epic || 'GOLD',
    size: volume,
    equity: account.equity,
    available_to_deal: account.available_to_deal,
    rules: {
      minSize: instrument.min_volume,
      maxSize: instrument.max_volume,
      step: instrument.volume_step,
    },
  });
  volume = clamped.size;
  if (clamped.adjusted) notes.push(`size_clamped:${clamped.reason || 'buying_power'}`);
  if (volume < instrument.min_volume) {
    return {
      allowed: false,
      volume: 0,
      risk_amount: sizing.risk_amount,
      reasons: ['buying_power_below_min'],
    };
  }

  return {
    allowed: true,
    volume,
    risk_amount: sizing.risk_amount,
    reasons: notes,
  };
}

export function sizeFromEquity(
  equity: number,
  cand: TradeCandidate,
  instrument: InstrumentSpec,
  cfg: MasterConfig,
  opts?: { consecutive_losses?: number }
): { allowed: boolean; volume: number; risk_amount: number; reasons: string[] } {
  const reasons: string[] = [];
  const slDist = Math.abs(cand.entry - cand.stop_loss);
  if (!(slDist > 0)) {
    return { allowed: false, volume: 0, risk_amount: 0, reasons: ['invalid_sl_distance'] };
  }
  const risk_amount = equity * cfg.risk_per_trade_pct;
  const step = instrument.volume_step;

  // Check- fixed lot (predictable exposure) + reduce_lot_after_loss soft degrade
  const reduceAfterLoss =
    cfg.reduce_lot_after_loss && (opts?.consecutive_losses ?? 0) > 0;
  if (reduceAfterLoss && cfg.reduce_lot_to > 0) {
    const volume = roundStep(
      Math.max(instrument.min_volume, Math.min(cfg.reduce_lot_to, instrument.max_volume)),
      step
    );
    if (volume < instrument.min_volume) {
      return { allowed: false, volume: 0, risk_amount, reasons: ['volume_below_min'] };
    }
    return {
      allowed: true,
      volume,
      risk_amount,
      reasons: ['reduce_lot_after_loss'],
    };
  }
  if (cfg.fixed_lot > 0) {
    const volume = roundStep(
      Math.max(instrument.min_volume, Math.min(cfg.fixed_lot, instrument.max_volume)),
      step
    );
    if (volume < instrument.min_volume) {
      return { allowed: false, volume: 0, risk_amount, reasons: ['volume_below_min'] };
    }
    return { allowed: true, volume, risk_amount, reasons: ['fixed_lot'] };
  }

  const points = slDist / Math.max(instrument.point, 1e-9);
  const lossPerLot = points * instrument.value_per_point_per_lot;
  if (!(lossPerLot > 0)) {
    return { allowed: false, volume: 0, risk_amount: 0, reasons: ['invalid_point_value'] };
  }
  let volume = risk_amount / lossPerLot;
  volume = Math.floor(volume / step + 1e-12) * step;
  volume = Math.max(0, Math.min(volume, instrument.max_volume));
  if (volume < instrument.min_volume) {
    reasons.push('volume_below_min');
    return { allowed: false, volume: 0, risk_amount, reasons };
  }
  return { allowed: true, volume: roundStep(volume, step), risk_amount, reasons };
}

function roundStep(v: number, step: number) {
  const p = Math.max(0, Math.round(-Math.log10(step)));
  return Number(v.toFixed(p));
}
