/**
 * Optional desk → MASTER bridge.
 * When MASTER_OWNS_PIPELINE=true, robotDesk feeds quotes/bars into MASTER
 * and skips legacy entry (MASTER owns decision→risk→execution→exit).
 */
import type { CapitalPriceCandle } from '../services/capitalCom.js';
import type { TenSecBar } from '../services/tenSecondOhlc.js';
import { capitalQuoteTsMs } from './broker.js';
import { createCapitalBroker, masterCapitalConnectionId } from './capitalFactory.js';
import { isMeaningfulBar } from './liveFeed.js';
import { masterRuntime } from './runtime.js';
import type { Bar, Quote } from './types.js';

export function masterOwnsPipeline(): boolean {
  return masterRuntime.ownsPipelineEffective();
}

/**
 * Desk Capital CST pool id — when MASTER owns pipeline, share env/MASTER pool
 * (900001) so desk quote session and CapitalBroker never fork CST on one login.
 * Legacy desk-only keeps the DB connection_id.
 */
export function deskCapitalPoolConnectionId(dbConnectionId?: number | null): number {
  if (masterOwnsPipeline()) return masterCapitalConnectionId();
  const n = Number(dbConnectionId);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : masterCapitalConnectionId();
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

/** Prefer 1m history; append latest closed 10s bar only when meaningful (no ATR poison). */
export function buildMasterBars(
  minuteCandles: CapitalPriceCandle[],
  closed10s: TenSecBar | null
): Bar[] {
  const bars = candlesToBars(minuteCandles);
  if (!closed10s) return bars;
  const last = bars.at(-1);
  const minRange = last
    ? Math.max(0.05, (last.high - last.low) * 0.15)
    : 0.05;
  const micro: Bar = {
    open: closed10s.open,
    high: closed10s.high,
    low: closed10s.low,
    close: closed10s.close,
    ts_ms: Date.now(),
  };
  if (isMeaningfulBar(micro, minRange)) bars.push(micro);
  return bars;
}

export function quoteFromCapital(input: {
  bid: number | null;
  ask: number | null;
  mid: number | null;
  /** Capital snapshot update_time — required for honest stale_quote gates */
  update_time?: string | number | null;
}): Quote | null {
  if (input.bid == null || input.ask == null || input.mid == null) return null;
  return {
    bid: input.bid,
    ask: input.ask,
    mid: input.mid,
    spread: input.ask - input.bid,
    // Never forge Date.now() — desk owns-pipeline must age like broker REST
    ts_ms: capitalQuoteTsMs(input.update_time),
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
    if (masterRuntime.broker?.name === 'CAPITAL') {
      // VS-System bindCapitalAccount — re-pin CFD on shared CST (never sticky first-writer)
      const broker = masterRuntime.broker as import('./broker.js').CapitalBroker;
      if (typeof broker.rebindCapitalAccount === 'function') {
        const want = String(creds.capitalAccountId || '').trim();
        if (want) {
          const cur =
            typeof broker.pinnedAccountId === 'function'
              ? broker.pinnedAccountId()
              : '';
          // Different CFD while opens remain would orphan prior book unmanaged
          if (want !== cur) {
            const gate = await masterRuntime.refuseDetachCapitalWithOpens();
            if (!gate.ok) {
              masterRuntime.broker_detail = `capital_rebind_refused:${gate.detail}`;
              return {
                ok: false,
                mode: masterRuntime.cfg.mode,
                detail: masterRuntime.broker_detail,
              };
            }
          }
          const pinned = await broker.rebindCapitalAccount(want);
          if (!pinned.ok) {
            masterRuntime.broker_detail = `capital_rebind_failed:${pinned.detail}`;
            return {
              ok: false,
              mode: masterRuntime.cfg.mode,
              detail: masterRuntime.broker_detail,
            };
          }
          masterRuntime.broker_detail = `capital_desk_rebound:${want}`;
        }
      }
    } else {
      const broker = createCapitalBroker({
        ...creds,
        // MASTER shares one CST pool with envBroker — never fork on desk DB connection_id
        connectionId: masterCapitalConnectionId(),
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
 * When owns-pipeline but Capital LIVE manage is deferred to desk, pause MASTER
 * autonomous entries so we do not dual-brain PAPER entries beside live desk risk.
 * Re-arms when MASTER safely owns again (or owns-pipeline is off).
 */
export function syncMasterEntryOwnership(brokerOpen: boolean): void {
  if (!masterOwnsPipeline()) {
    masterRuntime.setEntriesArmed(true);
    return;
  }
  if (masterOwnsManageSafely(brokerOpen)) {
    masterRuntime.setEntriesArmed(true);
  } else {
    masterRuntime.setEntriesArmed(false, 'desk_live_manage_deferred');
  }
}

/**
 * Run one MASTER tick from desk market data.
 * Returns detail string for desk tick log, or null if bridge inactive.
 */
let deskLastMid: number | null = null;
let deskFrozenPolls = 0;

export async function runMasterFromDesk(input: {
  epic: string;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  update_time?: string | number | null;
  minuteCandles: CapitalPriceCandle[];
  closed10s: TenSecBar | null;
}): Promise<{ active: boolean; detail: string; executed: boolean }> {
  if (!masterOwnsPipeline()) {
    return { active: false, detail: '', executed: false };
  }
  let quote = quoteFromCapital(input);
  const bars = buildMasterBars(input.minuteCandles, input.closed10s);
  if (!quote || bars.length < 5) {
    return {
      active: true,
      detail: 'MASTER · waiting bars/quote',
      executed: false,
    };
  }
  // Frozen mid across desk ticks — age ts_ms so DATA_STALE / soft-manage stay honest
  if (deskLastMid != null && Math.abs(quote.mid - deskLastMid) < 1e-9) {
    deskFrozenPolls += 1;
  } else {
    deskFrozenPolls = 0;
  }
  deskLastMid = quote.mid;
  if (deskFrozenPolls >= 24) {
    quote = { ...quote, ts_ms: Date.now() - 60_000 };
  }
  masterRuntime.setEpic(input.epic);
  // Desk Capital minute OHLC is venue structure — do not let Yahoo/broker feed
  // pause entries while desk already owns Capital bars.
  if (input.minuteCandles.length >= 10) {
    masterRuntime.applyStructureSeedGate('capital_ohlc');
  }
  if (!masterRuntime.running) {
    if (!masterRuntime.broker) masterRuntime.ensurePaperBroker();
    // Desk supplies quote/bars — do not start broker/Yahoo OHLC poll
    await masterRuntime.start({ skip_market_feed: true });
    if (input.minuteCandles.length >= 10) {
      masterRuntime.applyStructureSeedGate('capital_ohlc');
    }
  } else {
    // Already running (e.g. Capital attach) — stop conflicting Yahoo/broker poll
    masterRuntime.preferDeskMarketFeed();
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
