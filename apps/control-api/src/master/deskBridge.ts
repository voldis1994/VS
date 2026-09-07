/**
 * Optional desk → MASTER bridge.
 * When MASTER_OWNS_PIPELINE=true, robotDesk feeds quotes/bars into MASTER
 * and skips legacy entry (MASTER owns decision→risk→execution→exit).
 */
import type { CapitalPriceCandle } from '../services/capitalCom.js';
import type { TenSecBar } from '../services/tenSecondOhlc.js';
import { createCapitalBroker } from './capitalFactory.js';
import { masterRuntime } from './runtime.js';
import type { Bar, Quote } from './types.js';

export function masterOwnsPipeline(): boolean {
  return process.env.MASTER_OWNS_PIPELINE === 'true';
}

export function candlesToBars(candles: CapitalPriceCandle[]): Bar[] {
  return candles
    .filter((c) => c.close != null)
    .map((c) => ({
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      ts_ms: c.snapshotTime ? Date.parse(c.snapshotTime) : undefined,
    }));
}

/** Prefer 1m history; append latest closed 10s bar for freshness. */
export function buildMasterBars(
  minuteCandles: CapitalPriceCandle[],
  closed10s: TenSecBar | null
): Bar[] {
  const bars = candlesToBars(minuteCandles);
  if (closed10s) {
    bars.push({
      open: closed10s.open,
      high: closed10s.high,
      low: closed10s.low,
      close: closed10s.close,
      ts_ms: Date.now(),
    });
  }
  return bars;
}

export function quoteFromCapital(input: {
  bid: number | null;
  ask: number | null;
  mid: number | null;
}): Quote | null {
  if (input.bid == null || input.ask == null || input.mid == null) return null;
  return {
    bid: input.bid,
    ask: input.ask,
    mid: input.mid,
    spread: input.ask - input.bid,
    ts_ms: Date.now(),
  };
}

/** Ensure MASTER has Capital broker when live ownership is on. */
export async function ensureMasterCapitalBroker(creds: {
  environment: string;
  apiKey: string;
  identifier: string;
  password: string;
  connectionId?: number;
  capitalAccountId?: string | null;
}): Promise<{ ok: boolean; mode: string; detail: string }> {
  if (process.env.MASTER_LIVE_ENABLED === 'true') {
    if (masterRuntime.broker?.name !== 'CAPITAL') {
      const broker = createCapitalBroker({
        ...creds,
        connectionId: creds.connectionId && creds.connectionId > 0 ? creds.connectionId : 900002,
      });
      const opened = await broker.connect();
      if (!opened.ok) {
        // Do NOT silently fall back to PAPER — desk must keep managing live Capital risk
        masterRuntime.broker_detail = `capital_connect_failed:${opened.detail}`;
        return { ok: false, mode: masterRuntime.cfg.mode, detail: masterRuntime.broker_detail };
      }
      masterRuntime.attachBroker(broker);
      masterRuntime.setMode('LIVE');
      masterRuntime.broker_detail = 'capital_desk_connected';
    }
  } else {
    masterRuntime.setMode('PAPER');
    if (!masterRuntime.broker || masterRuntime.broker.name !== 'PAPER') {
      masterRuntime.ensurePaperBroker();
    }
    masterRuntime.broker_detail = masterRuntime.broker_detail || 'paper_desk';
  }
  if (!masterRuntime.running) await masterRuntime.start();
  return {
    ok: true,
    mode: masterRuntime.cfg.mode,
    detail: masterRuntime.broker_detail || masterRuntime.broker?.name || 'ok',
  };
}

/**
 * True only when MASTER can safely own exits for the desk session.
 * If owns-pipeline but Capital LIVE attach failed, desk must keep Best-Outcome manage.
 */
export function masterOwnsManageSafely(brokerOpen: boolean): boolean {
  if (!masterOwnsPipeline()) return false;
  if (masterRuntime.cfg.mode === 'LIVE' && masterRuntime.broker?.name === 'CAPITAL') {
    return true;
  }
  // PAPER ownership is fine when desk has no live Capital position to orphan
  if (!brokerOpen && masterRuntime.broker != null) return true;
  return false;
}

/**
 * Run one MASTER tick from desk market data.
 * Returns detail string for desk tick log, or null if bridge inactive.
 */
export async function runMasterFromDesk(input: {
  epic: string;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  minuteCandles: CapitalPriceCandle[];
  closed10s: TenSecBar | null;
}): Promise<{ active: boolean; detail: string; executed: boolean }> {
  if (!masterOwnsPipeline()) {
    return { active: false, detail: '', executed: false };
  }
  const quote = quoteFromCapital(input);
  const bars = buildMasterBars(input.minuteCandles, input.closed10s);
  if (!quote || bars.length < 5) {
    return {
      active: true,
      detail: 'MASTER · waiting bars/quote',
      executed: false,
    };
  }
  masterRuntime.setEpic(input.epic);
  if (!masterRuntime.running) {
    if (!masterRuntime.broker) masterRuntime.ensurePaperBroker();
    await masterRuntime.start();
  }
  const result = await masterRuntime.tick(bars, quote);
  const why =
    result.execution_detail ||
    result.decision.block_reason ||
    result.risk.reasons.join(',') ||
    result.decision.kind;
  const exitNote = result.exits
    ? ` · exits=${result.exits}${result.exit_reasons[0] ? ` (${result.exit_reasons[0]})` : ''}`
    : '';
  return {
    active: true,
    detail: `MASTER ${result.decision.kind} B${result.decision.buy.score.toFixed(2)}/S${result.decision.sell.score.toFixed(2)} · ${why}${exitNote}`,
    executed: result.executed,
  };
}
