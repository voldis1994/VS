/**
 * Canonical 5m entry pipeline with weighted evidence.
 *
 * HTF CONTEXT → 5M LOCATION → 5M STRUCTURE → LIQUIDITY → BOS/CHoCH
 * → SETUP → LTF CONFIRMATION → ENTRY
 *
 * LTF alone must never open a trade.
 */

import {
  analyzeMarketStructure,
  hasEvent,
  thesisPivot,
  structuralStopLevel,
  type MarketStructure,
  type StructureBar,
} from './marketStructure.js';
import { allowMicrostructureFromBars, syntheticRatio } from './ohlcQuality.js';
import { atrWilder, atrPctScore, moveThresholdPts } from './volatilityNorm.js';
import type { RegimeName } from './regimes.js';
import { normalizeRegime } from './regimes.js';

export type BrainSetup =
  | 'CONTINUATION'
  | 'PULLBACK'
  | 'BREAKOUT'
  | 'REVERSAL'
  | 'SWEEP_RECLAIM'
  | 'FAILED_BREAKOUT';

export type EvidenceKey =
  | 'htf_location'
  | 'structure_5m'
  | 'bos_choch'
  | 'sweep_reclaim'
  | 'displacement'
  | 'regime'
  | 'ltf_confirm'
  | 'volatility'
  | 'spread'
  | 'feed_agreement';

export type EvidenceItem = {
  key: EvidenceKey;
  weight: number;
  score: number; // 0..1
  detail: string;
};

export type HtfContext = {
  trend?: 'UP' | 'DOWN' | 'RANGE' | null;
  near_support?: boolean;
  near_resistance?: boolean;
  detail?: string;
};

export type LtfConfirm = {
  ok: boolean;
  momentum?: 'UP' | 'DOWN' | null;
  spread_ok?: boolean;
  detail: string;
};

export type BrainInput = {
  bars5m: StructureBar[];
  bars1m?: StructureBar[] | null;
  bars10s?: StructureBar[] | null;
  htf?: HtfContext | null;
  regime?: string | null;
  price: number;
  spread?: number | null;
  feed_agreement?: number | null; // 0..1
  broker_min_stop?: number | null;
  tick_size?: number | null;
};

export type BrainDecision = {
  entry: boolean;
  direction: 'BUY' | 'SELL' | null;
  setup: BrainSetup | null;
  reason: string;
  evidence: EvidenceItem[];
  evidence_score: number;
  structure: MarketStructure;
  structural_sl: number | null;
  hard_block: string | null;
};

const ENTRY_SCORE_MIN = 0.55;

function regimeEvidence(regime: RegimeName, direction: 'BUY' | 'SELL' | null): EvidenceItem {
  const r = regime;
  let score = 0.4;
  let detail = `regime ${r}`;
  if (direction === 'BUY') {
    if (r === 'TREND_UP' || r === 'PULLBACK_UPTREND' || r === 'BREAKOUT_UP') {
      score = 1;
      detail = `regime supports BUY · ${r}`;
    } else if (r === 'REVERSAL_CANDIDATE' || r === 'TRANSITION' || r === 'RANGE') {
      score = 0.55;
      detail = `regime neutral/reversal context · ${r}`;
    } else if (r === 'TREND_DOWN' || r === 'BREAKOUT_DOWN') {
      score = 0.25;
      detail = `regime against BUY · ${r} (not hard block)`;
    } else if (r === 'EXPANSION') {
      score = 0.5;
      detail = `high vol / expansion · ${r}`;
    }
  } else if (direction === 'SELL') {
    if (r === 'TREND_DOWN' || r === 'PULLBACK_DOWNTREND' || r === 'BREAKOUT_DOWN') {
      score = 1;
      detail = `regime supports SELL · ${r}`;
    } else if (r === 'REVERSAL_CANDIDATE' || r === 'TRANSITION' || r === 'RANGE') {
      score = 0.55;
      detail = `regime neutral/reversal context · ${r}`;
    } else if (r === 'TREND_UP' || r === 'BREAKOUT_UP') {
      score = 0.25;
      detail = `regime against SELL · ${r} (not hard block)`;
    }
  }
  return { key: 'regime', weight: 0.1, score, detail };
}

function mapRegimeToBrain(regime: string | null | undefined): RegimeName {
  const r = normalizeRegime(regime);
  return r;
}

function htfEvidence(htf: HtfContext | null | undefined, direction: 'BUY' | 'SELL'): EvidenceItem | null {
  if (!htf || htf.trend == null) {
    return null; // UNKNOWN HTF → caller blocks entry (#5)
  }
  if (direction === 'BUY' && htf.near_support) {
    return { key: 'htf_location', weight: 0.12, score: 0.95, detail: htf.detail || 'HTF near support' };
  }
  if (direction === 'SELL' && htf.near_resistance) {
    return { key: 'htf_location', weight: 0.12, score: 0.95, detail: htf.detail || 'HTF near resistance' };
  }
  if (direction === 'BUY' && htf.trend === 'UP') {
    return { key: 'htf_location', weight: 0.12, score: 0.8, detail: 'HTF trend UP' };
  }
  if (direction === 'SELL' && htf.trend === 'DOWN') {
    return { key: 'htf_location', weight: 0.12, score: 0.8, detail: 'HTF trend DOWN' };
  }
  if (direction === 'BUY' && htf.near_resistance) {
    return { key: 'htf_location', weight: 0.12, score: 0.35, detail: 'HTF near resistance · soft' };
  }
  if (direction === 'SELL' && htf.near_support) {
    return { key: 'htf_location', weight: 0.12, score: 0.35, detail: 'HTF near support · soft' };
  }
  return { key: 'htf_location', weight: 0.12, score: 0.5, detail: htf.detail || 'HTF context' };
}

function detectSetup(
  ms: MarketStructure,
  direction: 'BUY' | 'SELL'
): { setup: BrainSetup; detail: string } | null {
  const side = direction === 'BUY' ? 'BULL' : 'BEAR';
  const sweep = hasEvent(ms, 'SWEEP', side);
  const reclaim = hasEvent(ms, 'RECLAIM', side);
  const choch = hasEvent(ms, 'CHOCH', side);
  const bos = hasEvent(ms, 'BOS', side);
  const brk = hasEvent(ms, 'BREAKOUT', side);
  const fail = hasEvent(ms, 'FAILED_BREAKOUT', side);
  const retest = hasEvent(ms, 'RETEST', side);

  if (sweep && reclaim && (choch || bos)) {
    return {
      setup: 'SWEEP_RECLAIM',
      detail: `sweep→reclaim→${choch ? 'CHoCH' : 'BOS'}`,
    };
  }
  if (fail && direction === (fail.side === 'BULL' ? 'BUY' : 'SELL')) {
    return { setup: 'FAILED_BREAKOUT', detail: fail.detail };
  }
  if (choch) {
    return { setup: 'REVERSAL', detail: choch.detail };
  }
  if (brk && retest) {
    return { setup: 'BREAKOUT', detail: `breakout+retest · ${brk.detail}` };
  }
  if (bos && retest) {
    return { setup: 'CONTINUATION', detail: `BOS+retest · ${bos.detail}` };
  }
  if (bos) {
    return { setup: 'CONTINUATION', detail: bos.detail };
  }
  if (brk) {
    return { setup: 'BREAKOUT', detail: brk.detail };
  }
  if (ms.trend === 'UP' && direction === 'BUY' && (ms.swing_labels.high === 'HH' || ms.swing_labels.low === 'HL')) {
    return { setup: 'PULLBACK', detail: 'UP structure · pullback candidate' };
  }
  if (ms.trend === 'DOWN' && direction === 'SELL' && (ms.swing_labels.high === 'LH' || ms.swing_labels.low === 'LL')) {
    return { setup: 'PULLBACK', detail: 'DOWN structure · pullback candidate' };
  }
  return null;
}

function inferDirection(ms: MarketStructure): 'BUY' | 'SELL' | null {
  const bull =
    hasEvent(ms, 'CHOCH', 'BULL') ||
    hasEvent(ms, 'BOS', 'BULL') ||
    hasEvent(ms, 'RECLAIM', 'BULL') ||
    hasEvent(ms, 'RETEST', 'BULL') ||
    hasEvent(ms, 'FAILED_BREAKOUT', 'BULL');
  const bear =
    hasEvent(ms, 'CHOCH', 'BEAR') ||
    hasEvent(ms, 'BOS', 'BEAR') ||
    hasEvent(ms, 'RECLAIM', 'BEAR') ||
    hasEvent(ms, 'RETEST', 'BEAR') ||
    hasEvent(ms, 'FAILED_BREAKOUT', 'BEAR');
  if (bull && !bear) return 'BUY';
  if (bear && !bull) return 'SELL';
  if (ms.trend === 'UP' && hasEvent(ms, 'DISPLACEMENT', 'BULL')) return 'BUY';
  if (ms.trend === 'DOWN' && hasEvent(ms, 'DISPLACEMENT', 'BEAR')) return 'SELL';
  return null;
}

/**
 * Adaptive anti-chase — structure + volatility (no Gold hardcode).
 */
export function blockLateChaseAdaptive(
  direction: 'BUY' | 'SELL',
  bars5m: StructureBar[],
  atr: number | null
): { ok: boolean; reason: string } {
  if (bars5m.length < 3) return { ok: true, reason: 'no chase data' };
  const last = bars5m[bars5m.length - 1]!;
  const window = bars5m.slice(-6);
  const net = last.close - window[0]!.open;
  const price = Math.max(Math.abs(last.close), 1e-9);
  const climax = moveThresholdPts(price, atr, 1.2, 0.0025);
  const extending = moveThresholdPts(price, atr, 0.35, 0.0006);
  // UNKNOWN normalized threshold → BLOCK chase validation (#8)
  if (climax == null || extending == null) {
    return { ok: false, reason: 'ANTI-CHASE BLOCK · threshold UNKNOWN (no ATR/tick)' };
  }

  if (direction === 'BUY' && net >= climax) {
    const tail = bars5m.slice(-2);
    const tailNet = tail[tail.length - 1]!.close - tail[0]!.open;
    if (tailNet < extending * 0.3) {
      return {
        ok: false,
        reason: `ANTI-CHASE BUY · overextended +${net.toFixed(5)} (≥${climax.toFixed(5)}) stalled`,
      };
    }
    const high = Math.max(...window.map((b) => b.high));
    const range = high - Math.min(...window.map((b) => b.low));
    if (last.close >= high - range * 0.15 && Math.abs(last.close - last.open) < extending * 0.4) {
      return { ok: false, reason: 'ANTI-CHASE BUY · climax at swing high' };
    }
  }
  if (direction === 'SELL' && net <= -climax) {
    const tail = bars5m.slice(-2);
    const tailNet = tail[tail.length - 1]!.close - tail[0]!.open;
    if (tailNet > -extending * 0.3) {
      return {
        ok: false,
        reason: `ANTI-CHASE SELL · overextended ${net.toFixed(5)} stalled`,
      };
    }
    const low = Math.min(...window.map((b) => b.low));
    const range = Math.max(...window.map((b) => b.high)) - low;
    if (last.close <= low + range * 0.15 && Math.abs(last.close - last.open) < extending * 0.4) {
      return { ok: false, reason: 'ANTI-CHASE SELL · climax at swing low' };
    }
  }
  return { ok: true, reason: 'chase ok' };
}

function ltfConfirm(
  direction: 'BUY' | 'SELL',
  bars10s: StructureBar[] | null | undefined,
  bars1m: StructureBar[] | null | undefined,
  spread: number | null | undefined,
  atr: number | null,
  price: number
): LtfConfirm {
  const micro = allowMicrostructureFromBars(bars10s ?? bars1m ?? []);
  if (!micro.ok) {
    return { ok: false, detail: micro.reason };
  }

  const series = (bars1m && bars1m.length >= 2 ? bars1m : bars10s) ?? [];
  if (series.length < 2) {
    return { ok: false, detail: 'LTF insufficient' };
  }
  const net = series[series.length - 1]!.close - series[Math.max(0, series.length - 6)]!.open;
  const thr = moveThresholdPts(price, atr, 0.08, 0.00015);
  if (thr == null) {
    return { ok: false, momentum: null, spread_ok: false, detail: 'LTF threshold UNKNOWN' };
  }
  const mom: 'UP' | 'DOWN' | null =
    net >= thr ? 'UP' : net <= -thr ? 'DOWN' : null;

  // Spread UNKNOWN/invalid → NO ENTRY (#7)
  if (spread == null || !Number.isFinite(spread) || spread < 0) {
    return { ok: false, momentum: mom, spread_ok: false, detail: 'spread UNKNOWN' };
  }
  const sprOk = spread <= Math.max((atr ?? price * 0.001) * 0.35, price * 0.0002);

  if (direction === 'BUY' && mom === 'DOWN') {
    return { ok: false, momentum: mom, spread_ok: sprOk, detail: 'LTF momentum against BUY' };
  }
  if (direction === 'SELL' && mom === 'UP') {
    return { ok: false, momentum: mom, spread_ok: sprOk, detail: 'LTF momentum against SELL' };
  }
  if (!sprOk) {
    return { ok: false, momentum: mom, spread_ok: false, detail: 'spread too wide' };
  }
  // LTF momentum UNKNOWN (flat) → NO soft invent (#6)
  if (mom == null) {
    return { ok: false, momentum: null, spread_ok: sprOk, detail: 'LTF momentum UNKNOWN' };
  }
  return {
    ok: true,
    momentum: mom,
    spread_ok: true,
    detail: `LTF confirm · mom=${mom}`,
  };
}

function weightedScore(items: EvidenceItem[]): number {
  let w = 0;
  let s = 0;
  for (const it of items) {
    w += it.weight;
    s += it.weight * it.score;
  }
  return w > 0 ? s / w : 0;
}

/**
 * LTF-only path (10s color / micro move) — explicitly rejected.
 */
export function decideFromLtfAlone(
  bars10s: StructureBar[] | null | undefined
): BrainDecision {
  const empty = analyzeMarketStructure([]);
  return {
    entry: false,
    direction: null,
    setup: null,
    reason: 'LTF alone cannot open trade — need 5m setup',
    evidence: [],
    evidence_score: 0,
    structure: empty,
    structural_sl: null,
    hard_block: 'LTF_ONLY',
  };
}

export function decideFiveMinuteEntry(input: BrainInput): BrainDecision {
  // Forming candles must never confirm structure (#67)
  const bars5m = (input.bars5m ?? []).filter(
    (b) => b.provenance !== 'SYNTHETIC' && !(b as { forming?: boolean }).forming
  );
  const syn = syntheticRatio(input.bars5m);
  if (bars5m.length < 8) {
    const ms = analyzeMarketStructure(bars5m);
    return {
      entry: false,
      direction: null,
      setup: null,
      reason: `need ≥8 real 5m bars (have ${bars5m.length}${syn > 0 ? ` · syn ${(syn * 100).toFixed(0)}%` : ''})`,
      evidence: [],
      evidence_score: 0,
      structure: ms,
      structural_sl: null,
      hard_block: 'INSUFFICIENT_5M',
    };
  }

  const ms = analyzeMarketStructure(bars5m);
  const atr = ms.atr ?? atrWilder(bars5m, 14);
  let direction = inferDirection(ms);

  // Soft structure pullback direction from swing labels when no event yet
  if (!direction) {
    if (ms.trend === 'UP') direction = 'BUY';
    else if (ms.trend === 'DOWN') direction = 'SELL';
  }

  if (!direction) {
    return {
      entry: false,
      direction: null,
      setup: null,
      reason: `no 5m thesis · trend=${ms.trend} · swings ${ms.swing_labels.high}/${ms.swing_labels.low}`,
      evidence: [],
      evidence_score: 0,
      structure: ms,
      structural_sl: null,
      hard_block: 'NO_5M_THESIS',
    };
  }

  const setupHit = detectSetup(ms, direction);
  if (!setupHit) {
    return {
      entry: false,
      direction,
      setup: null,
      reason: `5m structure seen but no actionable setup · ${ms.trend}`,
      evidence: [],
      evidence_score: 0,
      structure: ms,
      structural_sl: null,
      hard_block: 'NO_SETUP',
    };
  }

  const chase = blockLateChaseAdaptive(direction, bars5m, atr);
  if (!chase.ok) {
    return {
      entry: false,
      direction,
      setup: setupHit.setup,
      reason: chase.reason,
      evidence: [],
      evidence_score: 0,
      structure: ms,
      structural_sl: null,
      hard_block: 'ANTI_CHASE',
    };
  }

  const htfItem = htfEvidence(input.htf, direction);
  if (!htfItem) {
    return {
      entry: false,
      direction,
      setup: setupHit.setup,
      reason: 'HTF UNKNOWN · NO ENTRY',
      evidence: [],
      evidence_score: 0,
      structure: ms,
      structural_sl: null,
      hard_block: 'HTF_UNKNOWN',
    };
  }

  const ltf = ltfConfirm(
    direction,
    input.bars10s,
    input.bars1m,
    input.spread,
    atr,
    input.price
  );
  if (!ltf.ok) {
    return {
      entry: false,
      direction,
      setup: setupHit.setup,
      reason: `5m setup ${setupHit.setup} · waiting LTF · ${ltf.detail}`,
      evidence: [
        { key: 'structure_5m', weight: 0.25, score: 0.85, detail: setupHit.detail },
        { key: 'ltf_confirm', weight: 0.2, score: 0, detail: ltf.detail },
      ],
      evidence_score: 0,
      structure: ms,
      structural_sl: structuralStopLevel(direction, thesisPivot(ms, direction), {
        atr,
        spread: input.spread,
        brokerMinStop: input.broker_min_stop,
        price: input.price,
        tickSize: input.tick_size,
      }),
      hard_block: 'LTF_PENDING',
    };
  }

  if (input.spread == null || !Number.isFinite(input.spread) || input.spread < 0) {
    return {
      entry: false,
      direction,
      setup: setupHit.setup,
      reason: 'spread UNKNOWN · NO ENTRY',
      evidence: [],
      evidence_score: 0,
      structure: ms,
      structural_sl: null,
      hard_block: 'SPREAD_UNKNOWN',
    };
  }

  if (input.feed_agreement == null || !Number.isFinite(input.feed_agreement)) {
    return {
      entry: false,
      direction,
      setup: setupHit.setup,
      reason: 'feed agreement UNKNOWN · NO ENTRY',
      evidence: [],
      evidence_score: 0,
      structure: ms,
      structural_sl: null,
      hard_block: 'FEED_UNKNOWN',
    };
  }

  const evidence: EvidenceItem[] = [];
  evidence.push(htfItem);
  evidence.push({
    key: 'structure_5m',
    weight: 0.22,
    score: 0.9,
    detail: `5m ${ms.trend} · ${ms.swing_labels.high}/${ms.swing_labels.low} · ${setupHit.detail}`,
  });

  const bos = hasEvent(ms, 'BOS', direction === 'BUY' ? 'BULL' : 'BEAR');
  const choch = hasEvent(ms, 'CHOCH', direction === 'BUY' ? 'BULL' : 'BEAR');
  evidence.push({
    key: 'bos_choch',
    weight: 0.18,
    score: bos || choch ? 1 : setupHit.setup === 'PULLBACK' ? 0.55 : 0.35,
    detail: choch?.detail || bos?.detail || 'no BOS/CHoCH yet',
  });

  const sweep = hasEvent(ms, 'SWEEP', direction === 'BUY' ? 'BULL' : 'BEAR');
  const reclaim = hasEvent(ms, 'RECLAIM', direction === 'BUY' ? 'BULL' : 'BEAR');
  evidence.push({
    key: 'sweep_reclaim',
    weight: 0.12,
    score: sweep && reclaim ? 1 : sweep || reclaim ? 0.6 : 0.35,
    detail: sweep && reclaim ? 'sweep+reclaim' : sweep?.detail || reclaim?.detail || 'none',
  });

  const disp = hasEvent(ms, 'DISPLACEMENT', direction === 'BUY' ? 'BULL' : 'BEAR');
  evidence.push({
    key: 'displacement',
    weight: 0.08,
    score: disp ? 1 : 0.4,
    detail: disp?.detail || 'no displacement',
  });

  evidence.push(regimeEvidence(mapRegimeToBrain(input.regime), direction));
  evidence.push({
    key: 'ltf_confirm',
    weight: 0.15,
    score: 1,
    detail: ltf.detail,
  });

  const vol = atrPctScore(atr, input.price);
  evidence.push({
    key: 'volatility',
    weight: 0.05,
    score: vol.score,
    detail: vol.detail,
  });

  const sprScore =
    1 - Math.min(1, input.spread / Math.max(atr ?? input.price * 0.001, 1e-9));
  evidence.push({
    key: 'spread',
    weight: 0.04,
    score: Math.max(0, sprScore),
    detail: `spread ${input.spread}`,
  });

  const feed = Math.max(0, Math.min(1, input.feed_agreement));
  evidence.push({
    key: 'feed_agreement',
    weight: 0.04,
    score: feed,
    detail: `feed ${feed.toFixed(2)}`,
  });

  const score = weightedScore(evidence);
  const sl = structuralStopLevel(direction, thesisPivot(ms, direction), {
    atr,
    spread: input.spread,
    brokerMinStop: input.broker_min_stop,
    price: input.price,
    tickSize: input.tick_size,
  });

  // Entry requires structural SL (#11)
  if (sl == null) {
    return {
      entry: false,
      direction,
      setup: setupHit.setup,
      reason: 'structural SL UNKNOWN · NO ENTRY',
      evidence,
      evidence_score: score,
      structure: ms,
      structural_sl: null,
      hard_block: 'STRUCT_SL_UNKNOWN',
    };
  }

  if (score < ENTRY_SCORE_MIN) {
    return {
      entry: false,
      direction,
      setup: setupHit.setup,
      reason: `evidence ${score.toFixed(2)} < ${ENTRY_SCORE_MIN} · ${setupHit.setup}`,
      evidence,
      evidence_score: score,
      structure: ms,
      structural_sl: sl,
      hard_block: 'EVIDENCE_LOW',
    };
  }

  return {
    entry: true,
    direction,
    setup: setupHit.setup,
    reason: `5M ${setupHit.setup} ${direction} · score ${score.toFixed(2)} · ${setupHit.detail} · ${ltf.detail}`,
    evidence,
    evidence_score: score,
    structure: ms,
    structural_sl: sl,
    hard_block: null,
  };
}

/** Aggregate N×10s REAL bars into 5m OHLC with clock-aligned boundaries.
 * Gaps must not compress time — require full contiguous 30×10s coverage.
 */
export function aggregateTenSecToFiveMin(
  tens: StructureBar[],
  barsPerFive = 30,
  nowMs = Date.now()
): StructureBar[] {
  const FIVE = 300_000;
  const TEN = 10_000;
  const real = tens.filter((b) => b.provenance !== 'SYNTHETIC');
  if (real.length < barsPerFive) return [];
  const buckets = new Map<number, StructureBar[]>();
  for (const b of real) {
    if (b.open_time_ms % TEN !== 0) continue;
    const key = Math.floor(b.open_time_ms / FIVE) * FIVE;
    if (key + FIVE > nowMs) continue; // forming — no look-ahead
    const arr = buckets.get(key) ?? [];
    arr.push(b);
    buckets.set(key, arr);
  }
  const out: StructureBar[] = [];
  for (const key of [...buckets.keys()].sort((a, b) => a - b)) {
    const chunk = (buckets.get(key) ?? []).sort((a, b) => a.open_time_ms - b.open_time_ms);
    const byT = new Map<number, StructureBar>();
    for (const c of chunk) byT.set(c.open_time_ms, c);
    const ordered: StructureBar[] = [];
    let complete = true;
    for (let i = 0; i < barsPerFive; i++) {
      const need = key + i * TEN;
      const hit = byT.get(need);
      if (!hit) {
        complete = false;
        break;
      }
      ordered.push(hit);
    }
    if (!complete) continue;
    const first = ordered[0]!;
    out.push({
      open_time_ms: key,
      open: first.open,
      high: Math.max(...ordered.map((c) => c.high)),
      low: Math.min(...ordered.map((c) => c.low)),
      close: ordered[ordered.length - 1]!.close,
      ticks: ordered.reduce((a, c) => a + (c.ticks ?? 1), 0),
      provenance: 'REAL',
    });
  }
  return out;
}

export function aggregateTenSecToOneMin(
  tens: StructureBar[],
  barsPerMin = 6,
  nowMs = Date.now()
): StructureBar[] {
  const ONE = 60_000;
  const TEN = 10_000;
  const real = tens.filter((b) => b.provenance !== 'SYNTHETIC');
  if (real.length < barsPerMin) return [];
  const buckets = new Map<number, StructureBar[]>();
  for (const b of real) {
    if (b.open_time_ms % TEN !== 0) continue;
    const key = Math.floor(b.open_time_ms / ONE) * ONE;
    if (key + ONE > nowMs) continue;
    const arr = buckets.get(key) ?? [];
    arr.push(b);
    buckets.set(key, arr);
  }
  const out: StructureBar[] = [];
  for (const key of [...buckets.keys()].sort((a, b) => a - b)) {
    const chunk = (buckets.get(key) ?? []).sort((a, b) => a.open_time_ms - b.open_time_ms);
    const byT = new Map<number, StructureBar>();
    for (const c of chunk) byT.set(c.open_time_ms, c);
    const ordered: StructureBar[] = [];
    let complete = true;
    for (let i = 0; i < barsPerMin; i++) {
      const need = key + i * TEN;
      const hit = byT.get(need);
      if (!hit) {
        complete = false;
        break;
      }
      ordered.push(hit);
    }
    if (!complete) continue;
    const first = ordered[0]!;
    out.push({
      open_time_ms: key,
      open: first.open,
      high: Math.max(...ordered.map((c) => c.high)),
      low: Math.min(...ordered.map((c) => c.low)),
      close: ordered[ordered.length - 1]!.close,
      ticks: ordered.reduce((a, c) => a + (c.ticks ?? 1), 0),
      provenance: 'REAL',
    });
  }
  return out;
}
