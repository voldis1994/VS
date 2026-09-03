/**
 * Replay backtest: public Yahoo GC=F 1m × desk brain (marketSetup + exitManage).
 *
 * Usage:
 *   npx tsx scripts/goldDayBacktest.ts
 *   npx tsx scripts/goldDayBacktest.ts --csv scripts/data/gc_f_2026-09-02_1m.csv --lot 0.1
 *
 * PnL model (Capital-style Gold CFD, GBP account): £1 per point per 1.0 lot
 * → lot 0.1 = £0.10 / point. Spread default 0.50 (half each side).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CapitalPriceCandle } from '../src/services/capitalCom.js';
import {
  buildStructure,
  decideUnifiedEntry,
  emptySetup,
  emptyStructure,
  entryAgainstMarketMove,
  entryCandleConfirmDeny,
  flowFlipAtExtreme,
  liveFlow,
  minuteConfirmBar,
  updateSetupSticky,
  type MarketSetup,
  type StructureBook,
} from '../src/services/marketSetup.js';
import {
  decideBestOutcomeExit,
  executableFavorableMove,
  favorableMove,
  type ExitSnapshot,
} from '../src/services/exitManage.js';
import { postExitEntryGate } from '../src/services/exitReentry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

type Bar = CapitalPriceCandle & { ts: number };

type TradeRow = {
  i: number;
  side: 'BUY' | 'SELL';
  setup: string;
  playbook: string;
  entryReason: string;
  entryTs: number;
  entryMid: number;
  entryFill: number;
  exitTs: number;
  exitMid: number;
  exitFill: number;
  points: number;
  pnlGbp: number;
  mfe: number;
  mae: number;
  holdBars: number;
  exitReason: string;
  atTip: boolean;
  atFloor: boolean;
  nearHigh: boolean;
  nearLow: boolean;
  wrong: boolean;
  wrongWhy: string | null;
};

type MissedRow = {
  ts: number;
  side: 'BUY' | 'SELL';
  setup: string;
  block: string;
  category: 'post_exit' | 'against_move' | 'candle' | 'climax_or_other';
  shadowPts: number;
  shadowPnlGbp: number;
  shadowMfe: number;
  shadowHold: number;
  shadowExit: string;
  unnecessary: boolean;
};

function shadowForward(opts: {
  bars: Bar[];
  startI: number;
  side: 'BUY' | 'SELL';
  playbook: string;
  setupKind: string;
  entryFill: number;
  entryTs: number;
  halfSpread: number;
  gbpPerPoint: number;
  setNow: (ms: number) => void;
}): Omit<MissedRow, 'ts' | 'side' | 'setup' | 'block' | 'category' | 'unnecessary'> {
  const { bars, startI, side, playbook, setupKind, entryFill, halfSpread, gbpPerPoint, setNow } =
    opts;
  let mfe = 0;
  let mae = 0;
  for (let j = startI + 1; j < bars.length; j++) {
    const window = bars.slice(Math.max(0, j + 1 - 120), j + 1);
    const minutes = window.map(({ open, high, low, close }) => ({ open, high, low, close }));
    const last = bars[j]!;
    setNow(last.ts * 1000);
    const mid = last.close;
    const bid = mid - halfSpread;
    const ask = mid + halfSpread;
    const favMid = favorableMove(side, entryFill, mid);
    mfe = Math.max(mfe, favMid);
    mae = Math.min(mae, favMid);
    const snap: ExitSnapshot = {
      open_side: side,
      entry_price: entryFill,
      entry_at: new Date(opts.entryTs * 1000).toISOString(),
      mfe,
      mae,
      peak_retention: mfe > 1e-9 ? Math.max(0, favMid) / mfe : null,
      playbook: playbook as 'LONG' | 'SCALP' | 'FADE',
      entry_setup: setupKind,
      flow_bias: liveFlow(minutes),
      flow_flip: flowFlipAtExtreme(minutes),
    };
    const decision = decideBestOutcomeExit(snap, { mid, bid, ask });
    const end = j === bars.length - 1;
    if (decision.exit || end) {
      const points = executableFavorableMove(side, entryFill, { mid, bid, ask });
      return {
        shadowPts: points,
        shadowPnlGbp: points * gbpPerPoint,
        shadowMfe: mfe,
        shadowHold: j - startI,
        shadowExit: end && !decision.exit ? 'EOD flatten' : decision.reason,
      };
    }
  }
  return {
    shadowPts: 0,
    shadowPnlGbp: 0,
    shadowMfe: mfe,
    shadowHold: 0,
    shadowExit: 'no forward bars',
  };
}

function parseArgs(argv: string[]) {
  const out = {
    csv: resolve(__dirname, 'data/gc_f_2026-09-02_1m.csv'),
    lot: 0.1,
    spread: 0.5,
    warmup: 60,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--csv') out.csv = resolve(argv[++i]!);
    else if (a === '--lot') out.lot = Number(argv[++i]);
    else if (a === '--spread') out.spread = Number(argv[++i]);
    else if (a === '--warmup') out.warmup = Number(argv[++i]);
  }
  return out;
}

function loadCsv(path: string): Bar[] {
  const text = readFileSync(path, 'utf8').trim().split(/\r?\n/);
  const rows: Bar[] = [];
  for (let i = 1; i < text.length; i++) {
    const [ts, o, h, l, c] = text[i]!.split(',');
    const t = Number(ts);
    const open = Number(o);
    const high = Number(h);
    const low = Number(l);
    const close = Number(c);
    if (![t, open, high, low, close].every(Number.isFinite)) continue;
    rows.push({ ts: t, open, high, low, close });
  }
  return rows;
}

function toHours(minutes: Bar[]): CapitalPriceCandle[] {
  const byHour = new Map<number, Bar[]>();
  for (const b of minutes) {
    const h = Math.floor(b.ts / 3600) * 3600;
    const arr = byHour.get(h) || [];
    arr.push(b);
    byHour.set(h, arr);
  }
  const hours: CapitalPriceCandle[] = [];
  for (const [, bars] of [...byHour.entries()].sort((a, b) => a[0] - b[0])) {
    hours.push({
      open: bars[0]!.open,
      high: Math.max(...bars.map((x) => x.high)),
      low: Math.min(...bars.map((x) => x.low)),
      close: bars[bars.length - 1]!.close,
    });
  }
  return hours;
}

function classifyWrong(t: TradeRow): { wrong: boolean; why: string | null } {
  // Tip/floor chase against structure book at entry
  if (t.side === 'BUY' && t.atTip) {
    return { wrong: true, why: 'BUY at tip (virsotne) — tip-chase' };
  }
  if (t.side === 'SELL' && t.atFloor) {
    return { wrong: true, why: 'SELL at floor — dump-floor chase' };
  }
  // Never printed a run, closed red
  if (t.pnlGbp < 0 && t.mfe < 0.8) {
    return { wrong: true, why: 'Loss with no real MFE run (<0.8pt) — wrong side / late' };
  }
  // Immediate failure: flipped/thesis within 2 minutes while red
  if (
    t.pnlGbp < 0 &&
    t.holdBars <= 2 &&
    /MoveFlip|ThesisFailure|EarlyCut|HardInvalidation|ReversalStop/i.test(t.exitReason)
  ) {
    return { wrong: true, why: `Fast fail (${t.holdBars}m) · ${t.exitReason.split('·')[0]!.trim()}` };
  }
  // Near edge BUY/SELL that lost
  if (t.pnlGbp < 0 && t.side === 'BUY' && t.nearHigh) {
    return { wrong: true, why: 'Losing BUY near swing high' };
  }
  if (t.pnlGbp < 0 && t.side === 'SELL' && t.nearLow) {
    return { wrong: true, why: 'Losing SELL near swing low' };
  }
  return { wrong: false, why: null };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const bars = loadCsv(opts.csv);
  if (bars.length < opts.warmup + 30) {
    throw new Error(`Need more bars: have ${bars.length}`);
  }

  const halfSpread = opts.spread / 2;
  const gbpPerPoint = opts.lot; // £1/pt @ 1.0 lot

  let simNow = bars[opts.warmup]!.ts * 1000;
  const realNow = Date.now;
  Date.now = () => simNow;

  let structure: StructureBook = emptyStructure('backtest seed');
  let setup: MarketSetup = emptySetup('backtest seed');
  let open: {
    side: 'BUY' | 'SELL';
    setup: string;
    playbook: string;
    entryReason: string;
    entryTs: number;
    entryBar: number;
    entryMid: number;
    entryFill: number;
    mfe: number;
    mae: number;
    atTip: boolean;
    atFloor: boolean;
    nearHigh: boolean;
    nearLow: boolean;
  } | null = null;

  let lastExitMs = 0;
  let lastExitSide: 'BUY' | 'SELL' | null = null;
  let lastExitReason: string | null = null;
  let entryMinuteBucket = 0;

  const trades: TradeRow[] = [];
  const missed: MissedRow[] = [];
  const blockReasons = new Map<string, number>();
  /** Debounce: one shadow miss per side per 5m (avoid counting same leg 20×) */
  let lastShadowSide: 'BUY' | 'SELL' | null = null;
  let lastShadowMs = 0;

  const bumpBlock = (why: string) => {
    blockReasons.set(why, (blockReasons.get(why) || 0) + 1);
  };

  const recordMiss = (
    why: string,
    category: MissedRow['category'],
    side: 'BUY' | 'SELL',
    setupKind: string,
    playbook: string,
    fill: number,
    barI: number,
    ts: number
  ) => {
    bumpBlock(why);
    const ms = ts * 1000;
    if (lastShadowSide === side && ms - lastShadowMs < 5 * 60_000) {
      return; // same blocked leg — already counted
    }
    lastShadowSide = side;
    lastShadowMs = ms;
    const sh = shadowForward({
      bars,
      startI: barI,
      side,
      playbook,
      setupKind,
      entryFill: fill,
      entryTs: ts,
      halfSpread,
      gbpPerPoint,
      setNow: (t) => {
        simNow = t;
      },
    });
    // Unnecessary = would have made money with a real run (not noise)
    const unnecessary = sh.shadowPnlGbp > 0.05 && sh.shadowMfe >= 0.8;
    missed.push({
      ts,
      side,
      setup: setupKind,
      block: why,
      category,
      ...sh,
      unnecessary,
    });
  };

  try {
    for (let i = opts.warmup; i < bars.length; i++) {
      const window = bars.slice(Math.max(0, i + 1 - 120), i + 1);
      const minutes = window.map(({ open, high, low, close }) => ({ open, high, low, close }));
      // Hour bias from full day so far (desk uses ~48h; one public day is enough for direction)
      const hours = toHours(bars.slice(0, i + 1)).slice(-48);
      const last = bars[i]!;
      simNow = last.ts * 1000;
      const mid = last.close;
      const bid = mid - halfSpread;
      const ask = mid + halfSpread;

      structure = buildStructure({
        minutes,
        hours,
        mid,
        prev: structure.ready ? structure : null,
      });
      setup = updateSetupSticky(setup, structure, minutes);

      // ——— manage open ———
      if (open) {
        const favMid = favorableMove(open.side, open.entryFill, mid);
        open.mfe = Math.max(open.mfe, favMid);
        open.mae = Math.min(open.mae, favMid);
        const snap: ExitSnapshot = {
          open_side: open.side,
          entry_price: open.entryFill,
          entry_at: new Date(open.entryTs * 1000).toISOString(),
          mfe: open.mfe,
          mae: open.mae,
          peak_retention: open.mfe > 1e-9 ? Math.max(0, favMid) / open.mfe : null,
          playbook: open.playbook as 'LONG' | 'SCALP' | 'FADE',
          entry_setup: open.setup,
          flow_bias: liveFlow(minutes),
          flow_flip: flowFlipAtExtreme(minutes),
        };
        const decision = decideBestOutcomeExit(snap, { mid, bid, ask });
        const endOfDay = i === bars.length - 1;
        if (decision.exit || endOfDay) {
          const exitFill =
            open.side === 'BUY' ? bid : ask;
          const points = executableFavorableMove(open.side, open.entryFill, {
            mid,
            bid,
            ask,
          });
          const row: TradeRow = {
            i: trades.length + 1,
            side: open.side,
            setup: open.setup,
            playbook: open.playbook,
            entryReason: open.entryReason,
            entryTs: open.entryTs,
            entryMid: open.entryMid,
            entryFill: open.entryFill,
            exitTs: last.ts,
            exitMid: mid,
            exitFill,
            points,
            pnlGbp: points * gbpPerPoint,
            mfe: open.mfe,
            mae: open.mae,
            holdBars: i - open.entryBar,
            exitReason: endOfDay && !decision.exit ? 'EOD flatten' : decision.reason,
            atTip: open.atTip,
            atFloor: open.atFloor,
            nearHigh: open.nearHigh,
            nearLow: open.nearLow,
            wrong: false,
            wrongWhy: null,
          };
          const w = classifyWrong(row);
          row.wrong = w.wrong;
          row.wrongWhy = w.why;
          trades.push(row);
          lastExitMs = simNow;
          lastExitSide = open.side;
          lastExitReason = row.exitReason;
          entryMinuteBucket = Math.floor(last.ts / 60); // wait next 1m (desk clearTradeState)
          open = null;
        }
        continue; // one position — desk freezes setup while open
      }

      // ——— entry ———
      const minuteBucket = Math.floor(last.ts / 60);
      const newMinute = !entryMinuteBucket || minuteBucket > entryMinuteBucket;
      if (!newMinute) {
        bumpBlock('wait next closed minute');
        continue;
      }

      const bar = minuteConfirmBar(minutes);
      if (!bar) {
        bumpBlock('no confirm bar');
        continue;
      }

      const entry = decideUnifiedEntry({
        setup,
        structure,
        bar,
        minutes,
        livePx: mid,
        allowNoneImpulse: false,
      });

      if (!entry) {
        // Candidate existed (ARMED + side) but unified gate killed it — shadow it
        if (
          setup.status === 'ARMED' &&
          setup.side &&
          setup.playbook &&
          setup.kind !== 'NONE'
        ) {
          const candleDeny = entryCandleConfirmDeny(setup.side, minutes);
          if (candleDeny) {
            recordMiss(
              candleDeny,
              'candle',
              setup.side,
              setup.kind,
              setup.playbook,
              setup.side === 'BUY' ? ask : bid,
              i,
              last.ts
            );
          } else if (entryAgainstMarketMove(setup.side, minutes, setup.kind)) {
            recordMiss(
              'against-move / local climax',
              'against_move',
              setup.side,
              setup.kind,
              setup.playbook,
              setup.side === 'BUY' ? ask : bid,
              i,
              last.ts
            );
          } else {
            bumpBlock('ARMED no confirm');
          }
        } else if (setup.kind === 'NONE' || setup.status === 'NONE') {
          bumpBlock('wait ARMED setup (NONE)');
        } else if (setup.status === 'FORMING') {
          bumpBlock('FORMING only');
        } else {
          bumpBlock('ARMED no confirm');
        }
        continue;
      }

      const reentry = postExitEntryGate({
        nowMs: simNow,
        lastExitMs,
        lastExitSide,
        lastExitReason,
        entryDirection: entry.direction,
        flow: liveFlow(minutes),
        vflip: flowFlipAtExtreme(minutes),
      });
      if (!reentry.allow) {
        const fill = entry.direction === 'BUY' ? ask : bid;
        recordMiss(
          reentry.detail || 'post-exit gate',
          'post_exit',
          entry.direction,
          entry.setup,
          entry.playbook,
          fill,
          i,
          last.ts
        );
        continue;
      }

      entryMinuteBucket = minuteBucket;
      if (lastExitSide && entry.direction !== lastExitSide) {
        lastExitSide = null;
        lastExitMs = 0;
        lastExitReason = null;
      }
      const fill = entry.direction === 'BUY' ? ask : bid;
      open = {
        side: entry.direction,
        setup: entry.setup,
        playbook: entry.playbook,
        entryReason: entry.reason,
        entryTs: last.ts,
        entryBar: i,
        entryMid: mid,
        entryFill: fill,
        mfe: 0,
        mae: 0,
        atTip: structure.at_tip,
        atFloor: structure.at_floor,
        nearHigh: structure.near_high,
        nearLow: structure.near_low,
      };
    }
  } finally {
    Date.now = realNow;
  }

  const wins = trades.filter((t) => t.pnlGbp > 0);
  const losses = trades.filter((t) => t.pnlGbp < 0);
  const flats = trades.filter((t) => t.pnlGbp === 0);
  const wrongs = trades.filter((t) => t.wrong);
  const totalPnl = trades.reduce((a, t) => a + t.pnlGbp, 0);
  const wrongWhy = new Map<string, number>();
  for (const t of wrongs) {
    const k = t.wrongWhy || 'unknown';
    wrongWhy.set(k, (wrongWhy.get(k) || 0) + 1);
  }
  const exitWhy = new Map<string, number>();
  for (const t of trades) {
    const k = t.exitReason.split('·')[0]!.trim();
    exitWhy.set(k, (exitWhy.get(k) || 0) + 1);
  }
  const setupWhy = new Map<string, number>();
  for (const t of trades) {
    setupWhy.set(t.setup, (setupWhy.get(t.setup) || 0) + 1);
  }

  const unnecessary = missed.filter((m) => m.unnecessary);
  const justifiedMiss = missed.filter((m) => !m.unnecessary);
  const missByCat = new Map<string, number>();
  const unnecByBlock = new Map<string, number>();
  let missedPnlLeft = 0;
  for (const m of missed) {
    missByCat.set(m.category, (missByCat.get(m.category) || 0) + 1);
    if (m.unnecessary) {
      unnecByBlock.set(m.block, (unnecByBlock.get(m.block) || 0) + 1);
      missedPnlLeft += m.shadowPnlGbp;
    }
  }

  const fmtTs = (ts: number) =>
    new Date(ts * 1000).toISOString().replace('.000Z', 'Z');

  const summary = {
    source: 'Yahoo Finance GC=F (public)',
    day: '2026-09-02',
    bars: bars.length,
    warmup: opts.warmup,
    lot: opts.lot,
    spread: opts.spread,
    gbp_per_point: gbpPerPoint,
    pnl_model: '£1 per point per 1.0 lot (Capital-style Gold CFD, GBP)',
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    flats: flats.length,
    total_pnl_gbp: Number(totalPnl.toFixed(2)),
    avg_pnl_gbp: trades.length ? Number((totalPnl / trades.length).toFixed(2)) : 0,
    wrong_entries: wrongs.length,
    wrong_entry_rate:
      trades.length > 0 ? Number(((wrongs.length / trades.length) * 100).toFixed(1)) : 0,
    wrong_reasons: Object.fromEntries(
      [...wrongWhy.entries()].sort((a, b) => b[1] - a[1])
    ),
    exit_reasons: Object.fromEntries(
      [...exitWhy.entries()].sort((a, b) => b[1] - a[1])
    ),
    setups: Object.fromEntries([...setupWhy.entries()].sort((a, b) => b[1] - a[1])),
    top_blocks: Object.fromEntries(
      [...blockReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
    ),
    missed_candidates: missed.length,
    unnecessary_blocks: unnecessary.length,
    justified_blocks: justifiedMiss.length,
    unnecessary_rate:
      missed.length > 0
        ? Number(((unnecessary.length / missed.length) * 100).toFixed(1))
        : 0,
    unnecessary_pnl_left_on_table_gbp: Number(missedPnlLeft.toFixed(2)),
    missed_by_category: Object.fromEntries(
      [...missByCat.entries()].sort((a, b) => b[1] - a[1])
    ),
    unnecessary_by_block: Object.fromEntries(
      [...unnecByBlock.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    ),
  };

  const outDir = resolve(__dirname, 'out');
  const reportDir = resolve(__dirname, 'reports');
  mkdirSync(outDir, { recursive: true });
  mkdirSync(reportDir, { recursive: true });
  const jsonPath = resolve(outDir, 'gold-2026-09-02-backtest.json');
  const mdPath = resolve(outDir, 'gold-2026-09-02-backtest.md');
  const jsonReport = resolve(reportDir, 'gold-2026-09-02-backtest.json');
  const mdReport = resolve(reportDir, 'gold-2026-09-02-backtest.md');

  const md = [
    `# Gold backtest — 2026-09-02 (1m)`,
    ``,
    `Source: **Yahoo Finance GC=F** (public). Lot **${opts.lot}**. Spread **${opts.spread}**.`,
    `PnL: **£${gbpPerPoint.toFixed(2)} / point** (£1/pt @ 1.0 lot).`,
    ``,
    `## Result`,
    ``,
    `| Metric | Value |`,
    `| --- | --- |`,
    `| Bars | ${bars.length} |`,
    `| Trades opened | **${trades.length}** |`,
    `| Wins / Losses / Flat | ${wins.length} / ${losses.length} / ${flats.length} |`,
    `| Total P&L | **£${totalPnl.toFixed(2)}** |`,
    `| Avg / trade | £${summary.avg_pnl_gbp} |`,
    `| Wrong entries | **${wrongs.length}** (${summary.wrong_entry_rate}%) |`,
    `| Missed candidates (shadow) | **${missed.length}** |`,
    `| Unnecessary blocks | **${unnecessary.length}** (${summary.unnecessary_rate}%) |`,
    `| £ left on table (unnecessary) | **£${missedPnlLeft.toFixed(2)}** |`,
    ``,
    `## Unnecessary blocks`,
    ``,
    `Shadow = ja būtu iegujuši ar to pašu exit smadzenēm. Unnecessary = shadow peļņa > £0.05 un MFE ≥ 0.8pt.`,
    ``,
    ...[...unnecByBlock.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `- **${n}×** ${k}`),
    unnecessary.length ? `` : `- (none)`,
    ``,
    `### By category`,
    ``,
    ...[...missByCat.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => {
        const un = unnecessary.filter((m) => m.category === k).length;
        return `- **${k}**: ${n} blocked · **${un}** unnecessary`;
      }),
    ``,
    `## Wrong entries — main reasons`,
    ``,
    ...[...wrongWhy.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `- **${n}×** ${k}`),
    wrongs.length ? `` : `- (none classified wrong)`,
    ``,
    `## Exit reasons`,
    ``,
    ...[...exitWhy.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `- **${n}×** ${k}`),
    ``,
    `## Setups`,
    ``,
    ...[...setupWhy.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `- **${n}×** ${k}`),
    ``,
    `## Trades`,
    ``,
    `| # | Side | Setup | Entry UTC | Exit UTC | Pts | £ | MFE | Hold | Exit | Wrong |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`,
    ...trades.map((t) => {
      const wrong = t.wrong ? (t.wrongWhy || 'yes').slice(0, 40) : '';
      return `| ${t.i} | ${t.side} | ${t.setup} | ${fmtTs(t.entryTs).slice(11, 16)} | ${fmtTs(t.exitTs).slice(11, 16)} | ${t.points.toFixed(2)} | ${t.pnlGbp.toFixed(2)} | ${t.mfe.toFixed(2)} | ${t.holdBars}m | ${t.exitReason.split('·')[0]!.trim()} | ${wrong} |`;
    }),
    ``,
    `Full JSON: \`scripts/reports/gold-2026-09-02-backtest.json\``,
    ``,
  ].join('\n');

  writeFileSync(jsonPath, JSON.stringify({ summary, trades, missed }, null, 2));
  writeFileSync(mdPath, md);
  writeFileSync(jsonReport, JSON.stringify({ summary, trades, missed }, null, 2));
  writeFileSync(mdReport, md);

  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nWrote ${mdPath}`);
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${mdReport}`);
}

main();
