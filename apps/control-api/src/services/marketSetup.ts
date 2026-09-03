/**
 * Setup-first market model (LIVE desk brain) — unified Aug13+Aug31.
 *
 * Capital quote + 1m (+ optional 1h) → STRUCTURE → SETUP → decideUnifiedEntry → BEST OUTCOME
 *
 * Hard rules:
 * - Setup changes only on structure refresh / closed bars — never on every quote tick
 * - NONE = no sticky setup; may still trade filtered 1m impulse (allowNoneImpulse)
 * - ARMED setup owns entry — impulse never opens against opposite ARMED side
 * - Open trade freezes setup; manage = best outcome only
 * - robotDesk refuses entry without broker SAFETY SL
 */
import type { CapitalPriceCandle } from './capitalCom.js';
import type { TradePlaybook } from './playbooks.js';
import { PLAYBOOK_ENTRY_BODY } from './playbooks.js';
import { bodyPct, type TenSecBar } from './tenSecondOhlc.js';

/**
 * Micro-swing confirm bar = last Capital 1m.
 * By default NO live mid overlay — live mid turns a forming wick into a fake body (spike chase).
 * Pass liveMid only for level-through checks (BREAKOUT), not for candle color confirm.
 */
export function minuteConfirmBar(
  minutes: CapitalPriceCandle[] | null | undefined,
  liveMid?: number | null,
  opts?: { overlayLive?: boolean }
): TenSecBar | null {
  if (!minutes?.length) return null;
  const m = minutes[minutes.length - 1]!;
  const overlay = opts?.overlayLive === true;
  const live =
    overlay && liveMid != null && Number.isFinite(liveMid) ? Number(liveMid) : m.close;
  return {
    open_time_ms: 0,
    open: m.open,
    high: Math.max(m.high, live),
    low: Math.min(m.low, live),
    close: live,
    ticks: Math.max(1, 5),
  };
}

/**
 * True when this 1m bar is a spike vs recent bodies — do not enter ON it; wait next confirm.
 * Gold 20:29 class: selling the impulse/first twitch without a confirming closed candle.
 */
export function isSpikeCandle(
  bar: CapitalPriceCandle,
  prior: CapitalPriceCandle[] | null | undefined
): boolean {
  if (!bar || !prior?.length) return false;
  const body = Math.abs(bar.close - bar.open);
  const range = Math.max(bar.high - bar.low, 1e-9);
  const px = Math.max(Math.abs(bar.close), 1e-9);
  const minSpike = Math.max(px * 0.00045, 1.8); // ~2pt Gold
  if (body < minSpike && range < minSpike * 1.15) return false;
  const sample = prior.slice(-8);
  if (sample.length < 3) return body >= minSpike * 1.5;
  const bodies = sample.map((c) => Math.abs(c.close - c.open)).sort((a, b) => a - b);
  const med = bodies[Math.floor(bodies.length / 2)]!;
  const typical = Math.max(med, px * 0.00012, 0.35);
  // Spike = body much larger than typical recent OR almost all-range wick thrust
  if (body >= typical * 2.8 && body >= minSpike) return true;
  if (range >= typical * 3.2 && body >= minSpike * 0.85) return true;
  return false;
}

/**
 * Entry candle confirm — closed 1m agrees with side.
 *
 * Soft (mid-swing / mid-leg CONT): do NOT sit through a dump waiting for a perfect
 * red after 5 reds + a doji pause. Allow tiny pause bars when recent bars already
 * print the move; skip 2-bar momentum; allow directional dump/rally spikes.
 * Strict (FADE / tip paths): 2 same-color + no entry on spike + no opposite color.
 */
export function entryCandleConfirmDeny(
  direction: 'BUY' | 'SELL',
  minutes?: CapitalPriceCandle[] | null,
  opts?: { soft?: boolean }
): string | null {
  if (!minutes || minutes.length < 2) return 'wait · need closed 1m confirm';
  const soft = !!opts?.soft;
  const cur = minutes[minutes.length - 1]!;
  const prev = minutes[minutes.length - 2]!;
  const prior = minutes.slice(0, -1);
  const body = Math.abs(cur.close - cur.open);
  const px = Math.abs(cur.close) || 1;
  const tinyBody = body <= Math.max(px * 0.00005, 0.2);

  const curBuy = cur.close > cur.open;
  const curSell = cur.close < cur.open;
  const curAgrees = direction === 'BUY' ? curBuy : curSell;
  // Real opposite body (not a doji pause mid-leg)
  const curFights =
    direction === 'BUY' ? curSell && !tinyBody : curBuy && !tinyBody;

  // Spike: always wait next bar — dump spike chase was soft P&L poison
  if (isSpikeCandle(cur, prior)) {
    return 'wait · spike 1m — need next candle confirm';
  }

  if (!soft) {
    if (direction === 'BUY' && !curBuy) return 'wait · need closed green 1m confirm';
    if (direction === 'SELL' && !curSell) return 'wait · need closed red 1m confirm';
    if (direction === 'BUY' && !(prev.close > prev.open)) {
      return 'wait · need 2 green 1m (momentum)';
    }
    if (direction === 'SELL' && !(prev.close < prev.open)) {
      return 'wait · need 2 red 1m (momentum)';
    }
  } else {
    // Soft = pause-doji exception only. If last bar is directional, keep strict 2-bar.
    // Live fail: 5 reds then O≈C doji → "need closed red" forever while dump runs.
    if (curAgrees) {
      if (direction === 'BUY' && !(prev.close > prev.open)) {
        return 'wait · need 2 green 1m (momentum)';
      }
      if (direction === 'SELL' && !(prev.close < prev.open)) {
        return 'wait · need 2 red 1m (momentum)';
      }
    } else if (curFights) {
      return direction === 'BUY'
        ? 'wait · need closed green 1m confirm'
        : 'wait · need closed red 1m confirm';
    } else {
      // Tiny pause / doji — allow only if dump/rally already proven
      const win = minutes.slice(-5);
      const dirBars = win.filter((c) =>
        direction === 'BUY' ? c.close > c.open : c.close < c.open
      ).length;
      const lastW = win[win.length - 1]!;
      const run =
        direction === 'BUY'
          ? lastW.close - Math.min(...win.map((c) => c.low))
          : Math.max(...win.map((c) => c.high)) - lastW.close;
      if (!(dirBars >= 3 && run >= 2.0)) {
        return direction === 'BUY'
          ? 'wait · need closed green 1m confirm'
          : 'wait · need closed red 1m confirm';
      }
    }
  }

  // After a large spike against us / exhaustion: confirm closes beyond spike close
  // (strict even for soft mid-leg — relaxing this regressed day P&L £2.61→£2.06)
  if (isSpikeCandle(prev, minutes.slice(0, -2))) {
    if (direction === 'SELL') {
      if (!(prev.close > prev.open && cur.close < prev.close)) {
        return 'wait · confirm after UP spike (close below spike)';
      }
    }
    if (direction === 'BUY') {
      if (!(prev.close < prev.open && cur.close > prev.close)) {
        return 'wait · confirm after DOWN spike (close above spike)';
      }
    }
  }

  return null;
}

/** Soft candle — mid-swing / flow-flip mid-leg only (not tip CONTINUATION up/down). */
export function isSoftCandleSetupReason(reason: string | null | undefined): boolean {
  return /FLOW flip mid-leg|IMPULSE (UP|DOWN) mid-leg|CONTINUATION mid-swing/i.test(
    String(reason || '')
  );
}

export const SETUP_KINDS = [
  'CONTINUATION',
  'PULLBACK',
  'BREAKOUT',
  'FADE',
  'FAILED_BREAK',
  'NONE',
] as const;
export type SetupKind = (typeof SETUP_KINDS)[number];

export type SetupStatus = 'NONE' | 'FORMING' | 'ARMED';

export type StructureBook = {
  ready: boolean;
  swing_high: number;
  swing_low: number;
  mid: number;
  span: number;
  bias: 'ABOVE' | 'BELOW' | 'INSIDE';
  near_high: boolean;
  near_low: boolean;
  /** True tip — tighter than near_high. Live swing hugs price mid-leg so near_* is often true. */
  at_tip: boolean;
  /** True floor — tighter than near_low. Blocks SELL-the-bottom without freezing mid-dump CONTINUATION. */
  at_floor: boolean;
  hour_bias: 'UP' | 'DOWN' | 'FLAT' | 'UNKNOWN';
  bar_count: number;
  detail: string;
  updated_at: string;
};

export type MarketSetup = {
  kind: SetupKind;
  side: 'BUY' | 'SELL' | null;
  playbook: TradePlaybook | null;
  status: SetupStatus;
  swing_high: number;
  swing_low: number;
  reason: string;
  /** Sticky confirm counter — setup flips only after enough agreeing updates */
  confirm: number;
  updated_at: string;
  /** Both sides watched at once — desk shows BUY & SELL candidates */
  watch_buy?: string | null;
  watch_sell?: string | null;
};

export type SetupEntry = {
  direction: 'BUY' | 'SELL';
  setup: SetupKind;
  playbook: TradePlaybook;
  reason: string;
};

const MIN_SWING_BARS = 20;
/** Faster pivots — old RIGHT=3 meant a new low was invisible for ~3 minutes (SELL-the-bottom class). */
const PIVOT_LEFT = 2;
const PIVOT_RIGHT = 1;
const SETUP_CONFIRM = 2;
/** FADE / FAILED_BREAK only if swing extreme printed within this many 1m bars */
const FRESH_SWING_BARS = 12;

/** Edge band in price points — Gold-friendly floor */
function edgeEps(px: number, span: number): number {
  return Math.max(Math.abs(px) * 0.00035, span * 0.08, 0.8);
}

/**
 * True tip/floor band — much tighter than near_*.
 * Live swing high/low tracks price, so near_high/near_low stay true mid-leg;
 * only the printed extreme itself should block BUY/SELL.
 */
function tipFloorEps(px: number, span: number): number {
  return Math.max(Math.abs(px) * 0.00008, Math.min(span * 0.025, 0.45), 0.25);
}

/**
 * Swing high/low is fresh only if a recent 1m bar actually printed that extreme.
 * Blocks FADE SELL on a stale H mid-rally (4434 while climb continues to 4437)
 * and FADE BUY on a stale L mid-dump.
 */
export function isFreshSwingHigh(
  minutes: CapitalPriceCandle[],
  hi: number,
  eps: number,
  maxAgeBars = FRESH_SWING_BARS
): boolean {
  if (!(hi > 0) || minutes.length < 2) return false;
  const slice = minutes.slice(-Math.max(2, maxAgeBars));
  return slice.some((c) => c.high >= hi - eps * 0.2);
}

export function isFreshSwingLow(
  minutes: CapitalPriceCandle[],
  lo: number,
  eps: number,
  maxAgeBars = FRESH_SWING_BARS
): boolean {
  if (!(lo > 0) || minutes.length < 2) return false;
  const slice = minutes.slice(-Math.max(2, maxAgeBars));
  return slice.some((c) => c.low <= lo + eps * 0.2);
}

export function emptyStructure(detail = 'structure seeding'): StructureBook {
  return {
    ready: false,
    swing_high: 0,
    swing_low: 0,
    mid: 0,
    span: 0,
    bias: 'INSIDE',
    near_high: false,
    near_low: false,
    at_tip: false,
    at_floor: false,
    hour_bias: 'UNKNOWN',
    bar_count: 0,
    detail,
    updated_at: new Date().toISOString(),
  };
}

export function emptySetup(reason = 'no setup'): MarketSetup {
  return {
    kind: 'NONE',
    side: null,
    playbook: null,
    status: 'NONE',
    swing_high: 0,
    swing_low: 0,
    reason,
    confirm: 0,
    updated_at: new Date().toISOString(),
    watch_buy: null,
    watch_sell: null,
  };
}

function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Last swing high/low from minute pivots + live running extreme (last bar included). */
export function detectSwingLevels(minutes: CapitalPriceCandle[]): {
  high: number;
  low: number;
  ok: boolean;
} {
  if (minutes.length < MIN_SWING_BARS) {
    return { high: 0, low: 0, ok: false };
  }
  const pivotsHi: number[] = [];
  const pivotsLo: number[] = [];
  for (let i = PIVOT_LEFT; i < minutes.length - PIVOT_RIGHT; i++) {
    const c = minutes[i]!;
    let isHi = true;
    let isLo = true;
    for (let j = i - PIVOT_LEFT; j <= i + PIVOT_RIGHT; j++) {
      if (j === i) continue;
      const o = minutes[j]!;
      if (o.high >= c.high) isHi = false;
      if (o.low <= c.low) isLo = false;
    }
    if (isHi) pivotsHi.push(c.high);
    if (isLo) pivotsLo.push(c.low);
  }
  // Running extreme INCLUDES the last bar — provisional structure at the live low/high
  const runHi = Math.max(...minutes.map((c) => c.high));
  const runLo = Math.min(...minutes.map((c) => c.low));
  const pivotHi = pivotsHi.length > 0 ? pivotsHi[pivotsHi.length - 1]! : runHi;
  const pivotLo = pivotsLo.length > 0 ? pivotsLo[pivotsLo.length - 1]! : runLo;
  // Prefer the more extreme of pivot vs live run — so a new dump low is visible NOW
  const high = Math.max(pivotHi, runHi);
  const low = Math.min(pivotLo, runLo);
  if (!(high > low)) return { high: 0, low: 0, ok: false };
  return { high, low, ok: true };
}

function hourBiasFrom(hours: CapitalPriceCandle[] | null | undefined): StructureBook['hour_bias'] {
  if (!hours || hours.length < 3) return 'UNKNOWN';
  const last = hours.slice(-6);
  const bodies = last.map((c) => (c.close - c.open) / Math.max(Math.abs(c.open), 1e-9));
  const p = mean(bodies.map((v) => (v > 0.0002 ? 1 : v < -0.0002 ? -1 : 0)));
  if (p > 0.35) return 'UP';
  if (p < -0.35) return 'DOWN';
  return 'FLAT';
}

/**
 * Build durable structure from Capital minutes (+ optional hours).
 * Optional prevSwing keeps levels sticky across refreshes until clearly broken.
 */
export function buildStructure(input: {
  minutes: CapitalPriceCandle[];
  hours?: CapitalPriceCandle[] | null;
  mid?: number | null;
  prev?: StructureBook | null;
}): StructureBook {
  const { minutes, hours, mid: lastMid, prev } = input;
  if (!minutes.length || minutes.length < MIN_SWING_BARS) {
    return emptyStructure(`need ≥${MIN_SWING_BARS} minute bars · have ${minutes.length}`);
  }

  const swing = detectSwingLevels(minutes);
  if (!swing.ok) return emptyStructure('swing levels not found');

  let hi = swing.high;
  let lo = swing.low;

  // Stickiness: keep previous swing until price breaks it (wick OR close) — then snap to live extreme
  if (prev?.ready && prev.swing_high > prev.swing_low) {
    const last = minutes[minutes.length - 1]!;
    const brokeHigh = last.high > prev.swing_high || last.close > prev.swing_high * 1.00015;
    const brokeLow = last.low < prev.swing_low || last.close < prev.swing_low * 0.99985;
    if (!brokeHigh && Math.abs(hi - prev.swing_high) / Math.max(prev.swing_high, 1) < 0.002) {
      hi = prev.swing_high;
    } else if (!brokeHigh && hi < prev.swing_high) {
      // don't shrink high on noise — keep remembered resistance
      hi = prev.swing_high;
    }
    if (!brokeLow && Math.abs(lo - prev.swing_low) / Math.max(prev.swing_low, 1) < 0.002) {
      lo = prev.swing_low;
    } else if (!brokeLow && lo > prev.swing_low) {
      lo = prev.swing_low;
    }
    // Extend immediately to the printed break wick/close — do not wait 3m for a new pivot
    if (brokeHigh) hi = Math.max(swing.high, last.high, prev.swing_high);
    if (brokeLow) lo = Math.min(swing.low, last.low, prev.swing_low);
  }

  const midZ = (hi + lo) / 2;
  const span = Math.max(hi - lo, Math.abs(midZ) * 1e-9);
  const px =
    lastMid != null && Number.isFinite(lastMid)
      ? lastMid
      : minutes[minutes.length - 1]!.close;
  const eps = edgeEps(px, span);
  const tipEps = tipFloorEps(px, span);
  const near_high = px >= hi - eps;
  const near_low = px <= lo + eps;
  const at_tip = px >= hi - tipEps;
  const at_floor = px <= lo + tipEps;
  let bias: StructureBook['bias'] = 'INSIDE';
  if (px > midZ + span * 0.1) bias = 'ABOVE';
  else if (px < midZ - span * 0.1) bias = 'BELOW';

  const hb = hourBiasFrom(hours);

  return {
    ready: true,
    swing_high: hi,
    swing_low: lo,
    mid: midZ,
    span,
    bias,
    near_high,
    near_low,
    at_tip,
    at_floor,
    hour_bias: hb,
    bar_count: minutes.length,
    detail: `swing H${hi.toFixed(2)} L${lo.toFixed(2)} · ${bias} · 1h ${hb} · 1m×${minutes.length}`,
    updated_at: new Date().toISOString(),
  };
}

function persistence(minutes: CapitalPriceCandle[], n = 12): number {
  const slice = minutes.slice(-n);
  const bodies = slice.map((c) => (c.close - c.open) / Math.max(Math.abs(c.open), 1e-9));
  return mean(bodies.map((v) => (v > 0.00015 ? 1 : v < -0.00015 ? -1 : 0)));
}

/**
 * Local impulse from last few 1m bars — each V-leg must fire (dump then rally),
 * not cancel to net≈0 over a long window (that caused ZERO trades on 10s swings).
 * Must NOT fire on quiet range oscillation (false CONTINUATION).
 */
export function recentImpulse(
  minutes: CapitalPriceCandle[],
  mode: 'normal' | 'flip' = 'normal'
): 'UP' | 'DOWN' | null {
  const n = mode === 'flip' ? 3 : 5;
  const slice = minutes.slice(-n);
  if (slice.length < (mode === 'flip' ? 3 : 4)) return null;
  const first = slice[0]!;
  const last = slice[slice.length - 1]!;
  const pers = persistence(slice, slice.length);
  const net = last.close - first.open;
  const thr =
    mode === 'flip'
      ? Math.max(Math.abs(first.open) * 0.00035, 1.2)
      : Math.max(Math.abs(first.open) * 0.0005, 1.8);
  const persThr = mode === 'flip' ? 0.4 : 0.35;
  if (pers <= -persThr && net <= -thr) return 'DOWN';
  if (pers >= persThr && net >= thr) return 'UP';

  // Sharp last 2 minutes same direction — live V-leg without waiting for longer net
  if (slice.length >= 2) {
    const a = slice[slice.length - 2]!;
    const b = last;
    const sharp = b.close - a.open;
    const sharpThr = Math.max(Math.abs(a.open) * 0.00045, 2.0);
    const bothDown = a.close <= a.open && b.close < b.open;
    const bothUp = a.close >= a.open && b.close > b.open;
    if (sharp <= -sharpThr && bothDown) return 'DOWN';
    if (sharp >= sharpThr && bothUp) return 'UP';
  }
  return null;
}

/** Recent local high/low — sticky overnight swing span must not decide "late". */
export function recentLocalRange(
  minutes: CapitalPriceCandle[],
  n = 15
): { hi: number; lo: number; span: number } {
  const slice = minutes.slice(-Math.max(4, n));
  const hi = Math.max(...slice.map((c) => c.high));
  const lo = Math.min(...slice.map((c) => c.low));
  return { hi, lo, span: Math.max(hi - lo, 1) };
}

/** Chop / micro-NONE entry quality filters (ablation). */
export type MicroChopQuality =
  | 'raw'
  | 'hour'
  | 'impulse'
  | 'persist'
  | 'room'
  | 'cooldown'
  | 'strict';

/**
 * Extra gates for NONE→micro entries. Raw = only existing against-move/candle.
 * Strict stacks hour + impulse + mid-room + tip/floor + 8m cooldown.
 */
export function microChopEntryOk(opts: {
  quality: MicroChopQuality;
  direction: 'BUY' | 'SELL';
  structure: StructureBook;
  minutes: CapitalPriceCandle[];
  lastMicroEntryMs?: number | null;
  nowMs?: number;
}): { ok: boolean; detail: string } {
  const { quality, direction, structure, minutes } = opts;
  if (quality === 'raw') return { ok: true, detail: 'raw' };

  const last = minutes[minutes.length - 1];
  if (!last) return { ok: false, detail: 'no bars' };
  const imp = recentImpulse(minutes, 'flip') || recentImpulse(minutes);
  const pers = persistence(minutes);
  const local = recentLocalRange(minutes, 12);
  const nowMs = opts.nowMs ?? Date.now();
  const lastMicro = opts.lastMicroEntryMs ?? 0;

  const needHour = quality === 'hour' || quality === 'strict';
  const needImp = quality === 'impulse' || quality === 'strict';
  const needPers = quality === 'persist' || quality === 'strict';
  const needRoom = quality === 'room' || quality === 'strict';
  const needCd = quality === 'cooldown' || quality === 'strict';
  const cdMs = quality === 'strict' ? 8 * 60_000 : 10 * 60_000;

  if (needHour) {
    if (direction === 'BUY' && structure.hour_bias !== 'UP') {
      return { ok: false, detail: `hour_bias ${structure.hour_bias}≠UP` };
    }
    if (direction === 'SELL' && structure.hour_bias !== 'DOWN') {
      return { ok: false, detail: `hour_bias ${structure.hour_bias}≠DOWN` };
    }
  }
  if (needImp) {
    if (direction === 'BUY' && imp !== 'UP') {
      return { ok: false, detail: `no UP impulse (${imp || 'none'})` };
    }
    if (direction === 'SELL' && imp !== 'DOWN') {
      return { ok: false, detail: `no DOWN impulse (${imp || 'none'})` };
    }
  }
  if (needPers) {
    if (direction === 'BUY' && pers < 0.4) {
      return { ok: false, detail: `persist ${pers.toFixed(2)} < 0.4` };
    }
    if (direction === 'SELL' && pers > -0.4) {
      return { ok: false, detail: `persist ${pers.toFixed(2)} > -0.4` };
    }
  }
  if (needRoom) {
    if (local.span < 2.5) return { ok: false, detail: `local span ${local.span.toFixed(1)} < 2.5` };
    const pos = (last.close - local.lo) / local.span;
    // Need room to run — not buying local tip / selling local floor of the micro-range
    if (direction === 'BUY' && pos > 0.82) {
      return { ok: false, detail: `BUY late in local range (${(pos * 100).toFixed(0)}%)` };
    }
    if (direction === 'SELL' && pos < 0.18) {
      return { ok: false, detail: `SELL late in local range (${(pos * 100).toFixed(0)}%)` };
    }
  }
  if (quality === 'strict') {
    if (direction === 'BUY' && structure.at_tip) return { ok: false, detail: 'at_tip' };
    if (direction === 'SELL' && structure.at_floor) return { ok: false, detail: 'at_floor' };
  }
  if (needCd && lastMicro > 0 && nowMs - lastMicro < cdMs) {
    return {
      ok: false,
      detail: `micro cool-down ${Math.round((cdMs - (nowMs - lastMicro)) / 1000)}s`,
    };
  }
  return { ok: true, detail: quality };
}

/**
 * Live FADE quality — Gold 13:37 FADE SELL into UP marketTrend = −£0.63.
 * Hour alone is too blunt (blocked 03:37 FADE BUY winner during DOWN hour V-flip).
 * Gate on marketTrend; allow V-flip at extreme against hour.
 */
export function fadeEntryQualityOk(opts: {
  direction: 'BUY' | 'SELL';
  structure: StructureBook;
  minutes?: CapitalPriceCandle[] | null;
  bar: TenSecBar;
  swingHigh: number;
  swingLow: number;
}): { ok: boolean; detail: string } {
  const { direction, structure, minutes, bar, swingHigh, swingLow } = opts;
  const hour = structure.hour_bias;
  const flip = minutes?.length ? flowFlipAtExtreme(minutes) : null;
  const trend = minutes?.length ? marketTrend(minutes) : null;

  // Hard for SELL fades into UP trend — no exception (13:37 −£0.63 class).
  // BUY fade against DOWN trend OK only on V-flip UP (03:37 floor bounce).
  if (direction === 'SELL' && trend === 'UP') {
    return { ok: false, detail: 'FADE SELL vs marketTrend UP' };
  }
  if (direction === 'BUY' && trend === 'DOWN' && flip !== 'UP') {
    return { ok: false, detail: 'FADE BUY vs marketTrend DOWN' };
  }
  // Hour fight only when no V-flip covering the fade
  if (direction === 'SELL' && hour === 'UP' && flip !== 'DOWN') {
    return { ok: false, detail: 'FADE SELL vs hour UP' };
  }
  if (direction === 'BUY' && hour === 'DOWN' && flip !== 'UP') {
    return { ok: false, detail: 'FADE BUY vs hour DOWN' };
  }
  if (!minutes?.length) {
    return { ok: true, detail: 'fade ok · no minutes' };
  }
  const last = minutes[minutes.length - 1]!;
  const eps = edgeEps(last.close, Math.max(swingHigh - swingLow, structure.span, 1));
  if (direction === 'SELL') {
    if (!isFreshSwingHigh(minutes, swingHigh, eps)) {
      return { ok: false, detail: 'FADE SELL · stale high' };
    }
    if (!(last.close <= swingHigh - eps * 0.1)) {
      return { ok: false, detail: 'FADE SELL · no reclaim under high' };
    }
    if (last.close > last.open && last.high > swingHigh + eps * 0.25) {
      return { ok: false, detail: 'FADE SELL · still thrusting green' };
    }
  } else {
    if (!isFreshSwingLow(minutes, swingLow, eps)) {
      return { ok: false, detail: 'FADE BUY · stale low' };
    }
    if (!(last.close >= swingLow + eps * 0.1)) {
      return { ok: false, detail: 'FADE BUY · no reclaim over low' };
    }
    if (last.close < last.open && last.low < swingLow - eps * 0.25) {
      return { ok: false, detail: 'FADE BUY · still thrusting red' };
    }
  }
  if (direction === 'SELL' && bar.high < swingHigh - eps * 1.25) {
    return { ok: false, detail: 'FADE SELL · did not tag high' };
  }
  if (direction === 'BUY' && bar.low > swingLow + eps * 1.25) {
    return { ok: false, detail: 'FADE BUY · did not tag low' };
  }
  return { ok: true, detail: 'fade ok' };
}

/**
 * Live CONTINUATION quality — room + climax + tip/floor.
 * Persist kept light so real mid-leg dumps (01:57 winner) still fire.
 */
export function continuationEntryQualityOk(opts: {
  direction: 'BUY' | 'SELL';
  structure: StructureBook;
  minutes?: CapitalPriceCandle[] | null;
}): { ok: boolean; detail: string } {
  const { direction, structure, minutes } = opts;
  if (!minutes?.length) return { ok: true, detail: 'cont ok · no minutes' };
  const last = minutes[minutes.length - 1]!;
  const local = recentLocalRange(minutes, 12);

  if (direction === 'BUY' && structure.at_tip) {
    return { ok: false, detail: 'CONT BUY at_tip' };
  }
  if (direction === 'SELL' && structure.at_floor) {
    return { ok: false, detail: 'CONT SELL at_floor' };
  }
  if (direction === 'BUY' && structure.bias === 'BELOW') {
    return { ok: false, detail: 'CONT BUY vs bias BELOW' };
  }
  if (direction === 'SELL' && structure.bias === 'ABOVE') {
    return { ok: false, detail: 'CONT SELL vs bias ABOVE' };
  }
  if (local.span < 2.0) {
    return { ok: false, detail: `CONT local span ${local.span.toFixed(1)}` };
  }
  const pos = (last.close - local.lo) / local.span;
  // Room to run — not buying local tip / selling local floor of micro-range
  if (direction === 'BUY' && pos > 0.88) {
    return { ok: false, detail: `CONT BUY late local ${(pos * 100).toFixed(0)}%` };
  }
  if (direction === 'SELL' && pos < 0.12) {
    return { ok: false, detail: `CONT SELL late local ${(pos * 100).toFixed(0)}%` };
  }
  if (minutes.length >= 5 && atLocalClimax(direction, minutes)) {
    return { ok: false, detail: 'CONT at local climax' };
  }
  return { ok: true, detail: 'cont ok' };
}

/**
 * Extra gate for no_impulse mid-leg impulse arm — dump/rally must already be underway.
 * Plain continuationEntryQualityOk alone re-opened early tip-blip CONT (£−0.74 / £−0.63).
 */
export function midLegImpulseArmOk(opts: {
  direction: 'BUY' | 'SELL';
  structure: StructureBook;
  minutes?: CapitalPriceCandle[] | null;
}): boolean {
  const { direction, structure, minutes } = opts;
  if (!continuationEntryQualityOk({ direction, structure, minutes }).ok) return false;
  if (!minutes?.length) return false;
  const last = minutes[minutes.length - 1]!;
  const local = recentLocalRange(minutes, 12);
  const flow = priceFlowBias(minutes);
  const minRun = Math.max(local.span * 0.35, 2.5);
  if (direction === 'SELL') {
    if (flow !== 'DOWN') return false;
    if (local.hi - last.close < minRun) return false;
    if (persistence(minutes) > -0.2) return false;
  } else {
    if (flow !== 'UP') return false;
    if (last.close - local.lo < minRun) return false;
    if (persistence(minutes) < 0.2) return false;
  }
  return true;
}

/**
 * Longer market direction (~20×1m). Bounce tips must not erase a live dump/rally.
 * Gold 17:41 class: BUY @ 4369 after 4374→ dump — short impulse said UP, market was DOWN.
 * Left-behind extremes (failed to remake high/low) beat 2–3m bounce color.
 */
export function marketTrend(
  minutes: CapitalPriceCandle[] | null | undefined
): 'UP' | 'DOWN' | null {
  if (!minutes || minutes.length < 8) return null;
  const slice = minutes.slice(-20);
  const first = slice[0]!;
  const last = slice[slice.length - 1]!;
  const hi = Math.max(...slice.map((c) => c.high));
  const lo = Math.min(...slice.map((c) => c.low));
  const span = hi - lo;
  const thr = Math.max(Math.abs(last.close) * 0.0005, 2.0);
  if (span < thr) return null;
  const fromHi = hi - last.close;
  const fromLo = last.close - lo;
  const net = last.close - first.open;
  // Dump owns tape: left a clear high behind and not remaking it (bounce tip stays DOWN)
  if (fromHi >= thr && last.high < hi - thr * 0.25 && fromHi >= fromLo * 0.85) {
    return 'DOWN';
  }
  // Rally owns tape: left a clear low behind and not remaking it
  if (fromLo >= thr && last.low > lo + thr * 0.25 && fromLo >= fromHi * 0.85) {
    return 'UP';
  }
  if (net <= -thr) return 'DOWN';
  if (net >= thr) return 'UP';
  return null;
}

/**
 * Dump / rally bias including slow grinds (small red candles) that miss impulse persistence.
 * Used to hard-block BUY into dump / SELL into rally.
 * Longer marketTrend wins over a short bounce/retracement impulse —
 * EXCEPT a clear V-flip at a fresh extreme (2–3 agreeing 1m bars still printing).
 */
export function priceFlowBias(
  minutes: CapitalPriceCandle[] | null | undefined
): 'UP' | 'DOWN' | null {
  if (!minutes || minutes.length < 4) return null;

  // Flip-first at fresh swing extreme — do not late-SELL into BUY leg (Gold 19:45 class)
  const flipExtreme = flowFlipAtExtreme(minutes);
  if (flipExtreme) return flipExtreme;

  const trend = marketTrend(minutes);
  const imp = recentImpulse(minutes, 'flip') || recentImpulse(minutes);
  // Bounce mid-dump / dip mid-rally — market owns direction, not the 2–3m blip
  if (trend && imp && trend !== imp) return trend;
  if (trend) return trend;
  if (imp) return imp;
  const slice = minutes.slice(-6);
  const first = slice[0]!;
  const last = slice[slice.length - 1]!;
  const net = last.close - first.open;
  const thr = Math.max(Math.abs(first.open) * 0.00035, 1.4);
  // Count red vs green closes in window
  let down = 0;
  let up = 0;
  for (const c of slice) {
    if (c.close < c.open) down += 1;
    else if (c.close > c.open) up += 1;
  }
  if (net <= -thr && down >= up) return 'DOWN';
  if (net >= thr && up >= down) return 'UP';
  // Lower-high grind: last close below open of window start by thr even if mixed
  if (net <= -thr * 1.25) return 'DOWN';
  if (net >= thr * 1.25) return 'UP';
  return null;
}

/**
 * Clear V-reversal at a fresh local high/low — short reclaim beats sticky 20m trend.
 * Gold 19:45 class: dump to fresh low then 2–3 green 1m still printing → UP (block late SELL).
 * Mid-dump bounce tips that stall (last bar against the bounce) stay null.
 */
export function flowFlipAtExtreme(
  minutes: CapitalPriceCandle[] | null | undefined
): 'UP' | 'DOWN' | null {
  if (!minutes || minutes.length < 8) return null;
  const window = minutes.slice(-20);
  const last = window[window.length - 1]!;
  const hi = Math.max(...window.map((c) => c.high));
  const lo = Math.min(...window.map((c) => c.low));
  const span = hi - lo;
  const minSpan = Math.max(Math.abs(last.close) * 0.0005, 2.0);
  if (span < minSpan) return null;

  const trend = marketTrend(minutes);
  const eps = edgeEps(last.close, span);
  const recent = minutes.slice(-4);
  const printedLow = recent.some((c) => c.low <= lo + eps * 0.35);
  const printedHigh = recent.some((c) => c.high >= hi - eps * 0.35);
  const last3 = minutes.slice(-3);
  if (last3.length < 2) return null;

  const greens = last3.filter((c) => c.close > c.open).length;
  const reds = last3.filter((c) => c.close < c.open).length;
  const net3 = last.close - last3[0]!.open;
  // Lighter than recentImpulse — real Gold V-legs are often ~1–2pt over 2–3m
  const netThr = Math.max(Math.abs(last.close) * 0.00022, 0.9);

  // Dump → reclaim UP off fresh low (must still be printing green)
  if (
    trend === 'DOWN' &&
    printedLow &&
    greens >= 2 &&
    net3 >= netThr &&
    moveStillPrinting('UP', minutes) &&
    last.close >= lo + span * 0.12
  ) {
    return 'UP';
  }

  // Rally → reject DOWN off fresh high
  if (
    trend === 'UP' &&
    printedHigh &&
    reds >= 2 &&
    net3 <= -netThr &&
    moveStillPrinting('DOWN', minutes) &&
    last.close <= hi - span * 0.12
  ) {
    return 'DOWN';
  }

  // Stronger impulse flip (when it fires) with same extreme+printing guards
  const flip = recentImpulse(minutes, 'flip');
  if (flip === 'UP' && printedLow && moveStillPrinting('UP', minutes) && greens >= 2) {
    if (last.close >= lo + span * 0.12) return 'UP';
  }
  if (flip === 'DOWN' && printedHigh && moveStillPrinting('DOWN', minutes) && reds >= 2) {
    if (last.close <= hi - span * 0.12) return 'DOWN';
  }
  return null;
}

/** Current dump/rally — market trend first, then flip/impulse. */
export function liveFlow(
  minutes: CapitalPriceCandle[] | null | undefined
): 'UP' | 'DOWN' | null {
  if (!minutes?.length) return null;
  return priceFlowBias(minutes) || recentImpulse(minutes, 'flip') || recentImpulse(minutes);
}

/**
 * Block SELL into a live UP tape / BUY into live DOWN tape unless clear V-flip.
 * Gold 20:29 class: SELL @ 4381 right after winning BUY while rally still UP.
 */
export function entryFightsStickyTrend(
  direction: 'BUY' | 'SELL',
  minutes?: CapitalPriceCandle[] | null
): boolean {
  const trend = marketTrend(minutes);
  if (!trend) return false;
  const flip = flowFlipAtExtreme(minutes);
  if (direction === 'SELL' && trend === 'UP' && flip !== 'DOWN') return true;
  if (direction === 'BUY' && trend === 'DOWN' && flip !== 'UP') return true;
  return false;
}

/**
 * ONE structure rule: do not SELL at the printed floor, do not BUY at the printed tip.
 * Uses at_tip/at_floor (tight) — NOT near_high/near_low.
 * Live swing tracks price, so near_* stays true mid-leg and was freezing CONTINUATION.
 * BREAKOUT through the edge is allowed (that is the breakout).
 */
export function structureBlocksEntry(
  direction: 'BUY' | 'SELL',
  structure: StructureBook | null | undefined,
  setupKind?: string | null
): boolean {
  if (!structure?.ready) return false;
  const kind = String(setupKind || '').trim().toUpperCase();
  if (kind === 'BREAKOUT') return false;
  if (direction === 'SELL' && structure.at_floor) return true;
  if (direction === 'BUY' && structure.at_tip) return true;
  return false;
}

export function flowAgreesWithSide(
  side: 'BUY' | 'SELL' | null | undefined,
  minutes?: CapitalPriceCandle[] | null
): boolean {
  if (!side) return false;
  const f = liveFlow(minutes);
  if (!f) return false;
  return (side === 'BUY' && f === 'UP') || (side === 'SELL' && f === 'DOWN');
}

/**
 * Move still printing on the latest 1m candle.
 * If last minute already flipped against flow — entry is late (signal finished).
 */
export function moveStillPrinting(
  flow: 'UP' | 'DOWN',
  minutes?: CapitalPriceCandle[] | null
): boolean {
  if (!minutes?.length) return false;
  const last = minutes[minutes.length - 1]!;
  if (flow === 'UP') return last.close >= last.open;
  return last.close <= last.open;
}

/**
 * Confirm bar is still pushing — used for diagnostics / tests.
 * Prefer atLocalClimax for entry gates (new-extreme pushes late tip entries).
 */
export function confirmBarExtendsMove(
  direction: 'BUY' | 'SELL',
  minutes?: CapitalPriceCandle[] | null
): boolean {
  if (!minutes || minutes.length < 3) return false;
  const cur = minutes[minutes.length - 1]!;
  const prior = minutes.slice(-6, -1);
  const priorHi = Math.max(...prior.map((c) => c.high));
  const priorLo = Math.min(...prior.map((c) => c.low));
  if (direction === 'BUY') return cur.high >= priorHi;
  return cur.low <= priorLo;
}

/**
 * Buying the local tip / selling the local floor of the last ~8×1m — climax chase.
 * Gold day wrong entries: IMPULSE at end of micro-leg → 0 MFE reverse.
 */
export function atLocalClimax(
  direction: 'BUY' | 'SELL',
  minutes?: CapitalPriceCandle[] | null
): boolean {
  if (!minutes || minutes.length < 5) return false;
  const slice = minutes.slice(-8);
  const last = slice[slice.length - 1]!;
  const hi = Math.max(...slice.map((c) => c.high));
  const lo = Math.min(...slice.map((c) => c.low));
  const span = hi - lo;
  const minSpan = Math.max(Math.abs(last.close) * 0.00045, 1.6);
  if (span < minSpan) return false;
  if (direction === 'BUY') {
    return last.close >= hi - span * 0.12 || last.high >= hi - span * 0.05;
  }
  return last.close <= lo + span * 0.12 || last.low <= lo + span * 0.05;
}

/**
 * True when entry would fight the real market move (bounce tip / late flip / climax).
 * Gold backtest 2026-09-02: CONTINUATION entered on brief flow blip vs sticky trend
 * → 0 MFE then ThesisFailure/MoveFlip within 1–3m.
 * V-flip at fresh extreme is the only exception for trend fights.
 * BREAKOUT may still fire at the edge — climax block is for CONTINUATION-style rides.
 */
export function entryAgainstMarketMove(
  direction: 'BUY' | 'SELL',
  minutes?: CapitalPriceCandle[] | null,
  setupKind?: string | null
): boolean {
  if (!minutes?.length) return true;
  const flow = liveFlow(minutes);
  if (!flow) return true;
  if (direction === 'BUY' && flow !== 'UP') return true;
  if (direction === 'SELL' && flow !== 'DOWN') return true;

  const flip = flowFlipAtExtreme(minutes);
  const trend = marketTrend(minutes);
  const kind = String(setupKind || '').trim().toUpperCase();

  if (flip) {
    if (direction === 'BUY' && flip !== 'UP') return true;
    if (direction === 'SELL' && flip !== 'DOWN') return true;
    if (!moveStillPrinting(flow, minutes)) return true;
    if (moveAlreadyFinished(direction, minutes)) return true;
    // V-flip leg may reclaim through the local window — climax check would block the turn
    return false;
  }
  if (trend) {
    if (direction === 'BUY' && trend === 'DOWN') return true;
    if (direction === 'SELL' && trend === 'UP') return true;
  }

  if (!moveStillPrinting(flow, minutes)) return true;
  if (moveAlreadyFinished(direction, minutes)) return true;
  if (kind !== 'BREAKOUT' && atLocalClimax(direction, minutes)) return true;
  return false;
}

/**
 * True when chasing a move that already finished (tip / rolled spike).
 * Gold 13:24 SELL @ dump floor 4334.90 after 4344→4335 — late.
 * Gold 13:29 BUY @ 4337 after UP spike already gave back — late.
 * Does not replace moveStillPrinting — callers check candle agree separately.
 */
export function moveAlreadyFinished(
  direction: 'BUY' | 'SELL',
  minutes?: CapitalPriceCandle[] | null,
  price?: number
): boolean {
  if (!minutes || minutes.length < 4) return false;

  const px = price ?? minutes[minutes.length - 1]!.close;
  // Tight window = the impulse itself, not quiet range before it
  const slice = minutes.slice(-5);
  const last = slice[slice.length - 1]!;
  const hi = Math.max(...slice.map((c) => c.high));
  const lo = Math.min(...slice.map((c) => c.low));
  const span = hi - lo;
  const minSpan = Math.max(Math.abs(px) * 0.0007, 2.5);
  if (span < minSpan) return false;

  const lastBody = Math.abs(last.close - last.open);
  const hiAt = slice.reduce((best, c, i) => (c.high >= slice[best]!.high ? i : best), 0);
  const loAt = slice.reduce((best, c, i) => (c.low <= slice[best]!.low ? i : best), 0);
  const lastI = slice.length - 1;

  if (direction === 'SELL') {
    // Still extending / owning the live low with a red body — not finished
    if (px < lo) return false;
    if (loAt === lastI && last.close <= last.open) return false;
    const fromPeak = hi - px;
    // Dump mostly done + stalling at floor (tiny last body) — late short
    if (fromPeak >= span * 0.7 && last.low <= lo + span * 0.1 && lastBody < span * 0.2) {
      return true;
    }
    // Low printed earlier and price already bounced off it
    if (loAt <= lastI - 1 && px >= lo + span * 0.2 && fromPeak >= span * 0.55) {
      return true;
    }
    return false;
  }

  // BUY — tip chase or buying after the UP spike already rolled over
  // Still extending / owning the live high with a green body — not finished
  if (px > hi) return false;
  if (hiAt === lastI && last.close >= last.open) return false;
  const givenBack = hi - px;
  if (givenBack <= span * 0.12 && lastBody < span * 0.2 && last.high >= hi - span * 0.1) {
    return true;
  }
  const rallyInto = hi - slice[0]!.low;
  if (hiAt <= lastI - 2 && givenBack >= span * 0.22 && rallyInto >= minSpan) {
    return true;
  }
  // Long UP leg already ran — buying while parked/consolidating in top ~15% is tip-chase
  // (Gold 20:34 BUY @ 4383 after 4372→4383). Still-thrusting breakouts may continue.
  const win = minutes.slice(-20);
  const wHi = Math.max(...win.map((c) => c.high));
  const wLo = Math.min(...win.map((c) => c.low));
  const wSpan = wHi - wLo;
  const wNet = win[win.length - 1]!.close - win[0]!.open;
  if (
    wSpan >= minSpan &&
    wNet >= Math.max(Math.abs(px) * 0.001, 4.0) &&
    px >= wHi - wSpan * 0.15
  ) {
    const thrusting =
      last.close > last.open &&
      last.high >= wHi - wSpan * 0.08 &&
      lastBody >= Math.max(wSpan * 0.12, Math.abs(px) * 0.00025);
    if (!thrusting) return true;
  }
  return false;
}

/** Dual-side watch labels — desk shows both, not only the armed side. */
export function dualSideWatch(
  structure: StructureBook,
  minutes: CapitalPriceCandle[]
): { watch_buy: string | null; watch_sell: string | null } {
  if (!structure.ready || minutes.length < MIN_SWING_BARS) {
    return { watch_buy: null, watch_sell: null };
  }
  const last = minutes[minutes.length - 1]!;
  const hi = structure.swing_high;
  const lo = structure.swing_low;
  const eps = edgeEps(last.close, Math.max(hi - lo, structure.span, 1));
  const imp = recentImpulse(minutes, 'flip') || recentImpulse(minutes);
  const freshHi = isFreshSwingHigh(minutes, hi, eps);
  const freshLo = isFreshSwingLow(minutes, lo, eps);
  let watch_buy: string | null = null;
  let watch_sell: string | null = null;

  if (imp === 'UP' || last.close > hi || (last.close > structure.mid && structure.bias !== 'BELOW')) {
    watch_buy =
      last.close > hi
        ? `BUY break/through H${hi.toFixed(2)}`
        : `BUY cont · mid ${structure.mid.toFixed(2)}`;
  }
  if (imp === 'DOWN' || last.close < lo || (last.close < structure.mid && structure.bias !== 'ABOVE')) {
    watch_sell =
      last.close < lo
        ? `SELL break/through L${lo.toFixed(2)}`
        : `SELL cont · mid ${structure.mid.toFixed(2)}`;
  }
  if (freshHi && structure.near_high && imp !== 'UP') {
    watch_sell = `SELL fade H${hi.toFixed(2)}`;
  }
  if (freshLo && structure.near_low && imp !== 'DOWN') {
    watch_buy = `BUY fade L${lo.toFixed(2)}`;
  }
  return { watch_buy, watch_sell };
}

/** Ablation / policy: how CONTINUATION is armed from structure. */
export type ContinuationPolicy = 'default' | 'no_impulse' | 'narrow_midleg';

/**
 * Live desk policy — blank no_impulse left desk stuck on sticky BUY / NONE mid-dump
 * while watch already said SELL. Tip-blip IMPULSE→CONT stays banned; flow flip arms
 * mid-leg opposite CONT when dump/rally is already underway (see midLegImpulseArmOk).
 */
export const LIVE_CONTINUATION_POLICY: ContinuationPolicy = 'no_impulse';

/** Raw impulse blip → CONTINUATION (the Gold-day 0-MFE loss driver). */
export function isImpulseContinuationReason(reason: string | null | undefined): boolean {
  return /IMPULSE (UP|DOWN) →/.test(String(reason || ''));
}

/**
 * True mid-leg CONTINUATION (not tip-zone ride, not raw impulse arm).
 * Used by narrow_midleg policy at arm + entry.
 */
export function isNarrowMidlegContinuation(
  setup: { kind: string; side: 'BUY' | 'SELL' | null; reason: string },
  structure: StructureBook,
  minutes?: CapitalPriceCandle[] | null
): boolean {
  if (setup.kind !== 'CONTINUATION' || !setup.side) return false;
  if (isImpulseContinuationReason(setup.reason)) return false;
  const r = String(setup.reason || '');
  // Explicit mid-leg / mid-swing arms only — tip-zone "Rally/Dump through" stays out
  const midReason =
    /CONTINUATION (up|down) ·/.test(r) || /CONTINUATION mid-swing/.test(r);
  if (!midReason) return false;
  if (setup.side === 'BUY' && structure.at_tip) return false;
  if (setup.side === 'SELL' && structure.at_floor) return false;
  if (setup.side === 'BUY' && structure.bias === 'BELOW') return false;
  if (setup.side === 'SELL' && structure.bias === 'ABOVE') return false;
  if (minutes?.length && atLocalClimax(setup.side, minutes)) return false;
  return true;
}

function rawSetupFromStructure(
  structure: StructureBook,
  minutes: CapitalPriceCandle[],
  opts?: { continuationPolicy?: ContinuationPolicy }
): Omit<MarketSetup, 'confirm' | 'updated_at'> {
  const contPolicy = opts?.continuationPolicy ?? LIVE_CONTINUATION_POLICY;
  const skipImpulseCont =
    contPolicy === 'no_impulse' || contPolicy === 'narrow_midleg';
  const narrowOnly = contPolicy === 'narrow_midleg';

  if (!structure.ready || minutes.length < MIN_SWING_BARS) {
    return {
      kind: 'NONE',
      side: null,
      playbook: null,
      status: 'NONE',
      swing_high: structure.swing_high,
      swing_low: structure.swing_low,
      reason: structure.detail || 'structure not ready',
    };
  }

  const last = minutes[minutes.length - 1]!;
  const hi = structure.swing_high;
  const lo = structure.swing_low;
  const pers = persistence(minutes);
  const eps = edgeEps(last.close, Math.max(hi - lo, structure.span, 1));
  const closedAbove = last.close > hi;
  const closedBelow = last.close < lo;
  const pokeAbove = minutes.slice(-6).some((c) => c.high > hi && c.close <= hi);
  const pokeBelow = minutes.slice(-6).some((c) => c.low < lo && c.close >= lo);
  const imp = recentImpulse(minutes, 'flip') || recentImpulse(minutes);
  const freshHi = isFreshSwingHigh(minutes, hi, eps);
  const freshLo = isFreshSwingLow(minutes, lo, eps);

  // ——— IMPULSE FIRST — real extension only (not bounce mid-dump / late under high) ———
  // When book H/L is still the LOCAL extreme, keep the classic "late" distance vs swing span.
  // When book H/L is sticky overnight (far outside local range), only local late applies —
  // otherwise mid @4422 with H4440/L4417 is always "late" → eternal NONE · mid swing.
  if (imp === 'UP') {
    const flow = priceFlowBias(minutes);
    const local = recentLocalRange(minutes);
    const fromLocalHi = local.hi - last.close;
    const fromHi = hi - last.close;
    const span = Math.max(hi - lo, structure.span, 1);
    const bounceInDump = flow === 'DOWN';
    const hiIsLocal = hi <= local.hi + eps * 0.25;
    const lateUnderHigh =
      !closedAbove &&
      last.close < hi - eps * 0.5 &&
      (hiIsLocal
        ? fromHi >= Math.max(span * 0.22, eps * 2.5)
        : fromLocalHi >= Math.max(local.span * 0.5, eps * 1.5, 2.5));
    if (!bounceInDump && !lateUnderHigh) {
      if (closedAbove || last.close >= hi - eps * 0.5) {
        return {
          kind: 'BREAKOUT',
          side: 'BUY',
          playbook: 'SCALP',
          status: 'ARMED',
          swing_high: hi,
          swing_low: lo,
          reason: `IMPULSE UP through H${hi.toFixed(2)} → BUY flip now`,
        };
      }
      const impulseBuy = {
        kind: 'CONTINUATION' as const,
        side: 'BUY' as const,
        playbook: 'LONG' as const,
        status: 'ARMED' as const,
        swing_high: hi,
        swing_low: lo,
        reason: `IMPULSE UP → BUY flip now · mid ${structure.mid.toFixed(2)}`,
      };
      // Raw tip-blip ban stays — mid-leg impulse re-arm regressed Gold day (£2.54→£1.71).
      // Both-sides speed = sticky liveFlow flip + dual watch, not raw impulse CONT under no_impulse.
      if (!skipImpulseCont) return impulseBuy;
    }
  }
  if (imp === 'DOWN') {
    const flow = priceFlowBias(minutes);
    const local = recentLocalRange(minutes);
    const fromLocalLo = last.close - local.lo;
    const fromLo = last.close - lo;
    const span = Math.max(hi - lo, structure.span, 1);
    const bounceInRally = flow === 'UP';
    const loIsLocal = lo >= local.lo - eps * 0.25;
    const lateAboveFloor =
      !closedBelow &&
      last.close > lo + eps * 0.5 &&
      (loIsLocal
        ? fromLo >= Math.max(span * 0.22, eps * 2.5)
        : fromLocalLo >= Math.max(local.span * 0.5, eps * 1.5, 2.5));
    if (!bounceInRally && !lateAboveFloor) {
      if (closedBelow || last.close <= lo + eps * 0.5) {
        return {
          kind: 'BREAKOUT',
          side: 'SELL',
          playbook: 'SCALP',
          status: 'ARMED',
          swing_high: hi,
          swing_low: lo,
          reason: `IMPULSE DOWN through L${lo.toFixed(2)} → SELL flip now`,
        };
      }
      const impulseSell = {
        kind: 'CONTINUATION' as const,
        side: 'SELL' as const,
        playbook: 'LONG' as const,
        status: 'ARMED' as const,
        swing_high: hi,
        swing_low: lo,
        reason: `IMPULSE DOWN → SELL flip now · mid ${structure.mid.toFixed(2)}`,
      };
      if (!skipImpulseCont) return impulseSell;
    }
  }

  // FAILED_BREAK — only on a FRESH swing extreme, never mid-rally / mid-dump fade
  // Trend fights gated at entry (fadeEntryQualityOk)
  if (
    pokeAbove &&
    freshHi &&
    last.close <= hi &&
    last.close >= lo &&
    last.close < last.open
  ) {
    return {
      kind: 'FAILED_BREAK',
      side: 'SELL',
      playbook: 'FADE',
      status: 'ARMED',
      swing_high: hi,
      swing_low: lo,
      reason: `FAILED_BREAK at fresh swing high ${hi.toFixed(2)} → FADE SELL`,
    };
  }
  if (
    pokeBelow &&
    freshLo &&
    last.close >= lo &&
    last.close <= hi &&
    last.close > last.open
  ) {
    return {
      kind: 'FAILED_BREAK',
      side: 'BUY',
      playbook: 'FADE',
      status: 'ARMED',
      swing_high: hi,
      swing_low: lo,
      reason: `FAILED_BREAK at fresh swing low ${lo.toFixed(2)} → FADE BUY`,
    };
  }

  // BREAKOUT — close outside swing with persistence (no live impulse needed)
  if (closedAbove && pers > 0.2) {
    return {
      kind: 'BREAKOUT',
      side: 'BUY',
      playbook: 'SCALP',
      status: 'ARMED',
      swing_high: hi,
      swing_low: lo,
      reason: `BREAKOUT above ${hi.toFixed(2)} → BUY`,
    };
  }
  if (closedBelow && pers < -0.2) {
    return {
      kind: 'BREAKOUT',
      side: 'SELL',
      playbook: 'SCALP',
      status: 'ARMED',
      swing_high: hi,
      swing_low: lo,
      reason: `BREAKOUT below ${lo.toFixed(2)} → SELL`,
    };
  }

  // FADE at FRESH swing edges only — never SELL mid-rally / BUY mid-dump on stale level
  // Also: if price is still dumping, do NOT arm FADE BUY (falling knife) — ride SELL
  // Hour/trend fights are gated at entry (fadeEntryQualityOk) so V-flip floors can still arm
  const flow = priceFlowBias(minutes);
  if (structure.near_high && !closedAbove && freshHi && flow !== 'UP') {
    return {
      kind: 'FADE',
      side: 'SELL',
      playbook: 'FADE',
      status: 'ARMED',
      swing_high: hi,
      swing_low: lo,
      reason: `FADE SELL at fresh swing high ${hi.toFixed(2)} · no BUY at tip`,
    };
  }
  // Tip-zone ride (not true mid-leg) — skip under narrow_midleg
  if (!narrowOnly && structure.near_high && !closedAbove && freshHi && flow === 'UP') {
    return {
      kind: 'CONTINUATION',
      side: 'BUY',
      playbook: 'LONG',
      status: 'ARMED',
      swing_high: hi,
      swing_low: lo,
      reason: `Rally through high zone · BUY not FADE · H${hi.toFixed(2)}`,
    };
  }
  if (structure.near_low && !closedBelow && freshLo && flow !== 'DOWN') {
    return {
      kind: 'FADE',
      side: 'BUY',
      playbook: 'FADE',
      status: 'ARMED',
      swing_high: hi,
      swing_low: lo,
      reason: `FADE BUY at fresh swing low ${lo.toFixed(2)} · no SELL at floor`,
    };
  }
  if (!narrowOnly && structure.near_low && !closedBelow && freshLo && flow === 'DOWN') {
    return {
      kind: 'CONTINUATION',
      side: 'SELL',
      playbook: 'LONG',
      status: 'ARMED',
      swing_high: hi,
      swing_low: lo,
      reason: `Dump through low zone · SELL not FADE BUY · L${lo.toFixed(2)}`,
    };
  }

  // CONTINUATION / PULLBACK in trend (hour + minute persistence) — mid/pullback only
  // Gate on at_tip/at_floor (tight), not near_* — live swing hugs price so near_* freezes the leg.
  const span = Math.max(hi - lo, structure.span, 1);
  const trendUp =
    pers > 0.35 || structure.hour_bias === 'UP' || structure.bias === 'ABOVE';
  const trendDown =
    pers < -0.35 || structure.hour_bias === 'DOWN' || structure.bias === 'BELOW';

  if (trendUp && !closedBelow && !structure.at_tip) {
    if (last.close < structure.mid && last.close > lo) {
      return {
        kind: 'PULLBACK',
        side: 'BUY',
        playbook: 'LONG',
        status: 'FORMING',
        swing_high: hi,
        swing_low: lo,
        reason: `PULLBACK in up structure · buy toward ${lo.toFixed(2)}`,
      };
    }
    if (pers > 0.4 && structure.bias === 'ABOVE' && last.close < hi - tipFloorEps(last.close, span)) {
      return {
        kind: 'CONTINUATION',
        side: 'BUY',
        playbook: 'LONG',
        status: 'ARMED',
        swing_high: hi,
        swing_low: lo,
        reason: `CONTINUATION up · above mid ${structure.mid.toFixed(2)} · below tip ${hi.toFixed(2)}`,
      };
    }
  }

  if (trendDown && !closedAbove && !structure.at_floor) {
    if (last.close > structure.mid && last.close < hi) {
      return {
        kind: 'PULLBACK',
        side: 'SELL',
        playbook: 'LONG',
        status: 'FORMING',
        swing_high: hi,
        swing_low: lo,
        reason: `PULLBACK in down structure · sell toward ${hi.toFixed(2)}`,
      };
    }
    if (pers < -0.4 && structure.bias === 'BELOW' && last.close > lo + tipFloorEps(last.close, span)) {
      return {
        kind: 'CONTINUATION',
        side: 'SELL',
        playbook: 'LONG',
        status: 'ARMED',
        swing_high: hi,
        swing_low: lo,
        reason: `CONTINUATION down · below mid ${structure.mid.toFixed(2)} · above floor ${lo.toFixed(2)}`,
      };
    }
  }

  // Mid-swing ride — only when book H/L is sticky-wide vs local (overnight trap).
  // Do NOT use on normal local swings (Gold 13:50 bounce under high must stay blocked).
  {
    const local = recentLocalRange(minutes, 12);
    const flowNow = priceFlowBias(minutes);
    const stickyWide = span > local.span * 1.6;
    if (
      stickyWide &&
      !structure.at_floor &&
      !closedAbove &&
      flowNow === 'DOWN' &&
      last.close < structure.mid &&
      local.hi - last.close >= Math.max(local.span * 0.35, 1.5) &&
      pers <= -0.15
    ) {
      return {
        kind: 'CONTINUATION',
        side: 'SELL',
        playbook: 'LONG',
        status: 'ARMED',
        swing_high: hi,
        swing_low: lo,
        reason: `CONTINUATION mid-swing SELL · local dump from ${local.hi.toFixed(2)} · below mid ${structure.mid.toFixed(2)}`,
      };
    }
    if (
      stickyWide &&
      !structure.at_tip &&
      !closedBelow &&
      flowNow === 'UP' &&
      last.close > structure.mid &&
      last.close - local.lo >= Math.max(local.span * 0.35, 1.5) &&
      pers >= 0.15
    ) {
      return {
        kind: 'CONTINUATION',
        side: 'BUY',
        playbook: 'LONG',
        status: 'ARMED',
        swing_high: hi,
        swing_low: lo,
        reason: `CONTINUATION mid-swing BUY · local rally from ${local.lo.toFixed(2)} · above mid ${structure.mid.toFixed(2)}`,
      };
    }
  }

  // Stale edge → readable NONE
  if (structure.near_high && !freshHi) {
    return {
      kind: 'NONE',
      side: null,
      playbook: null,
      status: 'NONE',
      swing_high: hi,
      swing_low: lo,
      reason: `NONE · near H${hi.toFixed(2)} but stale high · watch both sides`,
    };
  }
  if (structure.near_low && !freshLo) {
    return {
      kind: 'NONE',
      side: null,
      playbook: null,
      status: 'NONE',
      swing_high: hi,
      swing_low: lo,
      reason: `NONE · near L${lo.toFixed(2)} but stale low · watch both sides`,
    };
  }

  return {
    kind: 'NONE',
    side: null,
    playbook: null,
    status: 'NONE',
    swing_high: hi,
    swing_low: lo,
    reason: `NONE · mid swing H${hi.toFixed(2)}/L${lo.toFixed(2)} · watching BUY&SELL · no impulse yet`,
  };
}

/**
 * Sticky setup update — impulse FLIPS instantly (BUY↔SELL).
 * Dual watch always attached so desk sees both sides.
 */
export function updateSetupSticky(
  prev: MarketSetup | null | undefined,
  structure: StructureBook,
  minutes: CapitalPriceCandle[],
  opts?: { continuationPolicy?: ContinuationPolicy }
): MarketSetup {
  const raw = rawSetupFromStructure(structure, minutes, opts);
  const now = new Date().toISOString();
  const prevSafe = prev || emptySetup();
  const imp = recentImpulse(minutes, 'flip') || recentImpulse(minutes);
  const flowNow = liveFlow(minutes);
  const last = minutes[minutes.length - 1];
  const watch = dualSideWatch(structure, minutes);

  const withWatch = (s: MarketSetup): MarketSetup => ({
    ...s,
    watch_buy: watch.watch_buy,
    watch_sell: watch.watch_sell,
  });

  const same =
    prevSafe.kind === raw.kind &&
    prevSafe.side === raw.side &&
    prevSafe.playbook === raw.playbook;

  if (same) {
    const confirm = Math.min(prevSafe.confirm + 1, SETUP_CONFIRM + 2);
    const status: SetupStatus =
      raw.kind === 'NONE'
        ? 'NONE'
        : confirm >= SETUP_CONFIRM
          ? raw.status === 'FORMING'
            ? 'FORMING'
            : 'ARMED'
          : 'FORMING';
    return withWatch({
      ...raw,
      status: raw.kind === 'NONE' ? 'NONE' : status,
      confirm,
      swing_high: structure.swing_high || raw.swing_high,
      swing_low: structure.swing_low || raw.swing_low,
      updated_at: now,
    });
  }

  // Impulse / breakout / continuation — INSTANT arm (flip without waiting sticky)
  if (
    raw.side &&
    (String(raw.reason).includes('IMPULSE') ||
      raw.kind === 'BREAKOUT' ||
      raw.kind === 'CONTINUATION')
  ) {
    return withWatch({
      ...raw,
      status: 'ARMED',
      confirm: SETUP_CONFIRM,
      reason:
        prevSafe.side && prevSafe.side !== raw.side
          ? `${raw.reason} · flipped from ${prevSafe.side}`
          : raw.reason,
      updated_at: now,
    });
  }

  // Leaving NONE for a real setup is instant
  if (prevSafe.kind === 'NONE' && raw.kind !== 'NONE' && raw.side) {
    return withWatch({
      ...raw,
      status: raw.status === 'FORMING' ? 'FORMING' : 'ARMED',
      confirm: SETUP_CONFIRM,
      updated_at: now,
    });
  }

  // Dump kills sticky BUY; rally kills sticky SELL — liveFlow flips without waiting impulse label
  const stickyBuyDead =
    prevSafe.side === 'BUY' &&
    (imp === 'DOWN' ||
      flowNow === 'DOWN' ||
      raw.side === 'SELL' ||
      (last != null &&
        prevSafe.swing_low > 0 &&
        last.close < prevSafe.swing_low - edgeEps(last.close, Math.max(structure.span, 1))));
  const stickySellDead =
    prevSafe.side === 'SELL' &&
    (imp === 'UP' ||
      flowNow === 'UP' ||
      raw.side === 'BUY' ||
      (last != null &&
        prevSafe.swing_high > 0 &&
        last.close > prevSafe.swing_high + edgeEps(last.close, Math.max(structure.span, 1))));

  if (stickyBuyDead || stickySellDead) {
    // Don't dump into NONE / weak opposite mid-move — arm mid-leg CONT when dump/rally underway
    let flipped = { ...raw };
    if (stickyBuyDead && midLegImpulseArmOk({ direction: 'SELL', structure, minutes })) {
      flipped = {
        kind: 'CONTINUATION',
        side: 'SELL',
        playbook: 'LONG',
        status: 'ARMED',
        swing_high: structure.swing_high,
        swing_low: structure.swing_low,
        reason: `FLOW flip mid-leg SELL · was sticky BUY · mid ${structure.mid.toFixed(2)}`,
      };
    } else if (stickySellDead && midLegImpulseArmOk({ direction: 'BUY', structure, minutes })) {
      flipped = {
        kind: 'CONTINUATION',
        side: 'BUY',
        playbook: 'LONG',
        status: 'ARMED',
        swing_high: structure.swing_high,
        swing_low: structure.swing_low,
        reason: `FLOW flip mid-leg BUY · was sticky SELL · mid ${structure.mid.toFixed(2)}`,
      };
    }
    return withWatch({
      ...flipped,
      status:
        flipped.kind === 'NONE' ? 'NONE' : flipped.status === 'FORMING' ? 'FORMING' : 'ARMED',
      confirm: flipped.kind === 'NONE' ? 0 : SETUP_CONFIRM,
      reason:
        flipped.reason +
        (stickyBuyDead ? ' · flipped off sticky BUY' : ' · flipped off sticky SELL'),
      updated_at: now,
    });
  }

  // Same-family candidate change — brief hold only if NOT opposite side
  if (
    prevSafe.kind !== 'NONE' &&
    prevSafe.confirm >= SETUP_CONFIRM &&
    raw.kind !== prevSafe.kind &&
    !(prevSafe.side && raw.side && prevSafe.side !== raw.side)
  ) {
    return withWatch({
      ...prevSafe,
      confirm: Math.max(0, prevSafe.confirm - 1),
      reason: `${prevSafe.reason} · holding (candidate ${raw.kind})`,
      updated_at: now,
    });
  }

  return withWatch({
    ...raw,
    status: raw.kind === 'NONE' ? 'NONE' : 'FORMING',
    confirm: 1,
    updated_at: now,
  });
}

/**
 * Entry on live forming/closed bar + structure — confirms an ARMED setup.
 * BREAKOUT/CONTINUATION: price through level / flow (not candle color).
 * FADE/FAILED_BREAK: bounce/reject at swing (reclaim, not body color gate).
 */
/** Block tip-chase only for FADE/PULLBACK at the extreme tip — not CONTINUATION/BREAKOUT. */
export function isTipChaseEntry(setup: MarketSetup, bar: TenSecBar): boolean {
  if (!setup.side || setup.kind === 'NONE' || setup.kind === 'BREAKOUT' || setup.kind === 'CONTINUATION') {
    return false;
  }
  if (setup.kind !== 'FADE' && setup.kind !== 'FAILED_BREAK' && setup.kind !== 'PULLBACK') {
    return false;
  }
  const hi = setup.swing_high;
  const lo = setup.swing_low;
  if (!(hi > lo)) return false;
  const eps = edgeEps(bar.close, hi - lo);
  // Narrower band — was 0.65 (blocked too many valid 10s entries)
  if (setup.side === 'BUY' && bar.close >= hi - eps * 0.3) return true;
  if (setup.side === 'SELL' && bar.close <= lo + eps * 0.3) return true;
  return false;
}

export function decideEntryFromSetup(
  setup: MarketSetup,
  bar: TenSecBar,
  minutes?: CapitalPriceCandle[] | null,
  livePx?: number | null,
  structure?: StructureBook | null
): SetupEntry | null {
  if (setup.kind === 'NONE' || setup.status !== 'ARMED' || !setup.side || !setup.playbook) {
    return null;
  }

  const book = setup.playbook;
  const hi = setup.swing_high;
  const lo = setup.swing_low;
  const px =
    livePx != null && Number.isFinite(livePx) ? Number(livePx) : bar.close;
  const eps = edgeEps(px, Math.max(hi - lo, 1));
  const flow = priceFlowBias(minutes);

  // Hard: never BUY into a dump / SELL into a rally (green blip mid-dump class).
  // Direction = priceFlowBias (flip-first at extremes) — not raw 20m marketTrend alone.
  if (setup.side === 'BUY' && flow === 'DOWN') return null;
  if (setup.side === 'SELL' && flow === 'UP') return null;
  if (entryFightsStickyTrend(setup.side, minutes)) return null;
  // near_low / near_high / tip-floor from structure book on the setup swings
  const tipEps = tipFloorEps(px, Math.max(hi - lo, 1));
  const structLike: StructureBook = {
    ready: true,
    swing_high: hi,
    swing_low: lo,
    mid: (hi + lo) / 2,
    span: Math.max(hi - lo, 1),
    bias: structure?.bias ?? 'INSIDE',
    near_high: px >= hi - eps,
    near_low: px <= lo + eps,
    at_tip: structure?.at_tip ?? px >= hi - tipEps,
    at_floor: structure?.at_floor ?? px <= lo + tipEps,
    hour_bias: structure?.hour_bias ?? 'UNKNOWN',
    bar_count: minutes?.length ?? 0,
    detail: '',
    updated_at: '',
  };
  if (structureBlocksEntry(setup.side, structLike, setup.kind)) return null;

  if (isTipChaseEntry(setup, { ...bar, close: px })) {
    return null;
  }

  if (setup.kind === 'FADE' || setup.kind === 'FAILED_BREAK') {
    const fadeQ = fadeEntryQualityOk({
      direction: setup.side,
      structure: structLike,
      minutes,
      bar: { ...bar, close: px },
      swingHigh: hi,
      swingLow: lo,
    });
    if (!fadeQ.ok) return null;
    if (setup.side === 'BUY') {
      const touched = bar.low <= lo + eps;
      // Only block if bar is clearly dumping through the floor
      const stillDumping = px < bar.open && bar.low < lo - eps * 0.5;
      // Reclaim above the touch — 1m structure + live price
      const reclaimed = px >= lo + eps * 0.15 && px > bar.low + eps * 0.2;
      if (touched && !stillDumping && reclaimed) {
        return {
          direction: 'BUY',
          setup: setup.kind,
          playbook: book,
          reason: `ENTRY · ${setup.kind} BUY bounce @ L${lo.toFixed(2)} · ${setup.reason}`,
        };
      }
      return null;
    }
    const touched = bar.high >= hi - eps;
    const stillRallying = px > bar.open && bar.high > hi + eps * 0.5;
    const rejected = px <= hi - eps * 0.15 && px < bar.high - eps * 0.2;
    if (touched && !stillRallying && rejected) {
      return {
        direction: 'SELL',
        setup: setup.kind,
        playbook: book,
        reason: `ENTRY · ${setup.kind} SELL reject @ H${hi.toFixed(2)} · ${setup.reason}`,
      };
    }
    return null;
  }

  if (setup.kind === 'BREAKOUT') {
    // Live price through swing — micro-swing level, not 2s candle body
    if (setup.side === 'BUY' && px > hi - eps * 0.15) {
      if (moveAlreadyFinished('BUY', minutes, px)) return null;
      return {
        direction: 'BUY',
        setup: 'BREAKOUT',
        playbook: book,
        reason: `ENTRY · BREAKOUT BUY through H${hi.toFixed(2)} @ ${px.toFixed(2)} · ${setup.reason}`,
      };
    }
    if (setup.side === 'SELL' && px < lo + eps * 0.15) {
      if (moveAlreadyFinished('SELL', minutes, px)) return null;
      return {
        direction: 'SELL',
        setup: 'BREAKOUT',
        playbook: book,
        reason: `ENTRY · BREAKOUT SELL through L${lo.toFixed(2)} @ ${px.toFixed(2)} · ${setup.reason}`,
      };
    }
    return null;
  }

  if (setup.kind === 'PULLBACK') {
    const contFlow = liveFlow(minutes);
    const mid = (hi + lo) / 2;
    if (setup.side === 'BUY') {
      if (flow === 'DOWN') return null;
      if (moveAlreadyFinished('BUY', minutes, bar.close)) return null;
      // Must touch pullback zone (near swing low / below mid) AND resume UP — not any bar under high
      const inPullZone = bar.low <= lo + eps * 1.5 || px <= mid + eps * 0.25;
      const resume = contFlow === 'UP' || px > bar.open;
      if (inPullZone && resume) {
        return {
          direction: 'BUY',
          setup: 'PULLBACK',
          playbook: book,
          reason: `ENTRY · PULLBACK BUY · ${setup.reason}`,
        };
      }
      return null;
    }
    if (flow === 'UP') return null;
    if (moveAlreadyFinished('SELL', minutes, bar.close)) return null;
    const inPullZone = bar.high >= hi - eps * 1.5 || px >= mid - eps * 0.25;
    const resume = contFlow === 'DOWN' || px < bar.open;
    if (inPullZone && resume) {
      return {
        direction: 'SELL',
        setup: 'PULLBACK',
        playbook: book,
        reason: `ENTRY · PULLBACK SELL · ${setup.reason}`,
      };
    }
    return null;
  }

  if (setup.kind === 'CONTINUATION') {
    const contFlow = liveFlow(minutes);
    if (!contFlow) return null;
    if (setup.side === 'BUY' && contFlow !== 'UP') return null;
    if (setup.side === 'SELL' && contFlow !== 'DOWN') return null;
    if (!moveStillPrinting(contFlow, minutes)) return null;
    if (moveAlreadyFinished(setup.side, minutes, bar.close)) return null;
    // Mid-swing / mid-leg CONTINUATION — room + climax; tip-zone dump/rally keeps lighter gates
    if (/mid-swing|CONTINUATION (up|down) ·|mid-leg/.test(setup.reason)) {
      const contQ = continuationEntryQualityOk({
        direction: setup.side,
        structure: structure ?? structLike,
        minutes,
      });
      if (!contQ.ok) return null;
    }
    return {
      direction: setup.side,
      setup: 'CONTINUATION',
      playbook: book,
      reason: `ENTRY · CONTINUATION ${setup.side} · flow ${contFlow} @ ${bar.close.toFixed(2)} · ${setup.reason}`,
    };
  }

  return null;
}

/**
 * Instant entry when dump/rally flow is live — market impulse, not candle color.
 * Uses forming OR closed bar price; do not wait for green/red body.
 */
export function decideEntryFromImpulseCandle(
  bar: TenSecBar,
  minutes?: CapitalPriceCandle[] | null
): SetupEntry | null {
  if (!bar || bar.ticks < 1) return null;
  if (!minutes?.length) return null;
  const mins = minutes;
  const trend = marketTrend(mins);
  const short = recentImpulse(mins, 'flip') || recentImpulse(mins);
  const flow = liveFlow(mins);
  if (!flow) return null;
  // Bounce/dip against market — block unless clear V-flip at fresh extreme already owns flow
  const flipped = flowFlipAtExtreme(mins);
  if (!flipped) {
    if (trend && short && trend !== short) return null;
    if (trend === 'DOWN' && flow === 'UP') return null;
    if (trend === 'UP' && flow === 'DOWN') return null;
  } else if (flipped !== flow) {
    return null;
  }
  // Signal finished — last 1m already turned against the move
  if (!moveStillPrinting(flow, mins)) return null;
  const direction: 'BUY' | 'SELL' = flow === 'UP' ? 'BUY' : 'SELL';
  // Never SELL mid-rally / BUY mid-dump without V-flip (20:29 −£0.13 class)
  if (entryFightsStickyTrend(direction, mins)) return null;
  // Tip / rolled move — Gold dump-floor SELL and post-spike BUY
  if (moveAlreadyFinished(direction, mins, bar.close)) return null;
  if (flow === 'DOWN') {
    return {
      direction: 'SELL',
      setup: 'CONTINUATION',
      playbook: 'LONG',
      reason: `ENTRY · DOWN impulse @ ${bar.close.toFixed(2)} · market flow`,
    };
  }
  if (flow === 'UP') {
    return {
      direction: 'BUY',
      setup: 'CONTINUATION',
      playbook: 'LONG',
      reason: `ENTRY · UP impulse @ ${bar.close.toFixed(2)} · market flow`,
    };
  }
  return null;
}

/**
 * When sticky setup is NONE mid-swing but the 1m market is moving through structure,
 * enter CONTINUATION with flow — micro-swing on 1m, not 2s body color.
 */
export function decideEntryFromTenSecMove(
  structure: StructureBook,
  bar: TenSecBar,
  minutes?: CapitalPriceCandle[] | null
): SetupEntry | null {
  if (!structure.ready || !(structure.swing_high > structure.swing_low)) return null;
  const thr = PLAYBOOK_ENTRY_BODY.LONG;
  const body = bodyPct(bar);
  const hi = structure.swing_high;
  const lo = structure.swing_low;
  const eps = edgeEps(bar.close, Math.max(hi - lo, structure.span, 1));
  const need = thr * 0.55;
  const flow = priceFlowBias(minutes);
  const live = liveFlow(minutes);
  // Move already finished on the last 1m — late entry, skip
  if (live && !moveStillPrinting(live, minutes)) return null;

  // 1m through level OR 1m displacement — not 2s green/red
  const throughHigh = bar.close > hi + eps * 0.05;
  const throughLow = bar.close < lo - eps * 0.05;

  if (body >= need || throughHigh) {
    // flow owns direction (incl. V-flip); do not also require bias away from BELOW
    if (flow === 'DOWN' || (structure.bias === 'BELOW' && flow !== 'UP')) return null;
    if (entryFightsStickyTrend('BUY', minutes)) return null;
    if (moveAlreadyFinished('BUY', minutes, bar.close)) return null;
    // Tip-chase: parked at swing high without clear break — skip
    if (!throughHigh && bar.close >= hi - eps * 0.3 && bar.close <= hi + eps * 0.15) return null;
    return {
      direction: 'BUY',
      setup: 'CONTINUATION',
      playbook: 'LONG',
      reason: `ENTRY · 1m micro-swing BUY @ ${bar.close.toFixed(2)} · setup was NONE`,
    };
  }
  if (body <= -need || throughLow) {
    if (flow === 'UP' || (structure.bias === 'ABOVE' && flow !== 'DOWN')) return null;
    if (entryFightsStickyTrend('SELL', minutes)) return null;
    if (moveAlreadyFinished('SELL', minutes, bar.close)) return null;
    if (!throughLow && bar.close <= lo + eps * 0.3 && bar.close >= lo - eps * 0.15) return null;
    return {
      direction: 'SELL',
      setup: 'CONTINUATION',
      playbook: 'LONG',
      reason: `ENTRY · 1m micro-swing SELL @ ${bar.close.toFixed(2)} · setup was NONE`,
    };
  }
  return null;
}

/**
 * Unified profitable brain (Aug13 clarity + Aug31 structure/safety).
 *
 * One dispatcher — never impulse-first against an ARMED opposite setup:
 * 1) ARMED setup owns entry (levels + dump/rally + tip-chase)
 * 2) ARMED CONTINUATION/BREAKOUT may confirm via same-side impulse
 * 3) NONE + ready structure → trade real 1m impulse / through-level (filtered)
 * 4) FORMING → wait
 */
export function decideUnifiedEntry(opts: {
  setup: MarketSetup;
  structure: StructureBook;
  bar: TenSecBar;
  minutes?: CapitalPriceCandle[] | null;
  livePx?: number | null;
  /** When false, NONE never opens (strict setup-only). Default true = catch real moves. */
  allowNoneImpulse?: boolean;
  /** Ablation / backtest: skip closed-candle + 2-bar momentum + spike gates */
  skipCandleConfirm?: boolean;
  /** Ablation / backtest: skip against-move + local climax gate */
  skipAgainstMove?: boolean;
  /**
   * CONTINUATION policy (ablation / candidate fix):
   * - no_impulse: refuse entries whose setup reason is raw IMPULSE → CONTINUATION
   * - narrow_midleg: only true mid-leg CONTINUATION (bias + not climax + mid reason)
   */
  continuationPolicy?: ContinuationPolicy;
}): SetupEntry | null {
  const {
    setup,
    structure,
    bar,
    minutes,
    livePx,
    allowNoneImpulse = true,
    skipCandleConfirm = false,
    skipAgainstMove = false,
    continuationPolicy = LIVE_CONTINUATION_POLICY,
  } = opts;
  if (!bar || bar.ticks < 1) return null;

  const armed =
    setup.status === 'ARMED' && setup.kind !== 'NONE' && !!setup.side && !!setup.playbook;

  let entry: SetupEntry | null = null;

  if (armed) {
    const fromSetup = decideEntryFromSetup(setup, bar, minutes, livePx, structure);
    if (fromSetup) {
      entry = fromSetup;
    } else if (setup.kind === 'CONTINUATION' || setup.kind === 'BREAKOUT') {
      // Same-side impulse only — never flip against sticky ARMED FADE/PULLBACK
      const impulse = decideEntryFromImpulseCandle(bar, minutes);
      if (impulse && impulse.direction === setup.side) {
        entry = {
          direction: impulse.direction,
          setup: setup.kind,
          playbook: setup.playbook || impulse.playbook,
          reason: `ENTRY · ${setup.kind} via impulse · ${impulse.reason}`,
        };
      }
    }
  } else if (setup.kind === 'NONE' || setup.status === 'NONE') {
    if (!allowNoneImpulse) return null;
    if (!structure.ready || !(structure.swing_high > structure.swing_low)) return null;

    const impulse = decideEntryFromImpulseCandle(bar, minutes);
    if (impulse) {
      // After V-flip, bias may still be BELOW/ABOVE from the old swing — trust flow
      if (!flowFlipAtExtreme(minutes)) {
        if (impulse.direction === 'BUY' && structure.bias === 'BELOW') return null;
        if (impulse.direction === 'SELL' && structure.bias === 'ABOVE') return null;
      }
      entry = {
        ...impulse,
        reason: `${impulse.reason} · unified NONE`,
      };
    } else {
      entry = decideEntryFromTenSecMove(structure, bar, minutes);
    }
  }

  if (!entry) return null;

  // Live entry quality — FADE tip always; CONTINUATION mid-leg / mid-swing / mid-leg impulse
  if (entry.setup === 'FADE' || entry.setup === 'FAILED_BREAK') {
    const fadeQ = fadeEntryQualityOk({
      direction: entry.direction,
      structure,
      minutes,
      bar,
      swingHigh: setup.swing_high || structure.swing_high,
      swingLow: setup.swing_low || structure.swing_low,
    });
    if (!fadeQ.ok) return null;
  }
  if (
    entry.setup === 'CONTINUATION' &&
    armed &&
    setup.kind === 'CONTINUATION' &&
    /mid-swing|CONTINUATION (up|down) ·|mid-leg/.test(setup.reason)
  ) {
    const contQ = continuationEntryQualityOk({
      direction: entry.direction,
      structure,
      minutes,
    });
    if (!contQ.ok) return null;
  }

  // CONTINUATION ablation gates (legacy IMPULSE → tip-blip text only)
  if (entry.setup === 'CONTINUATION') {
    if (
      continuationPolicy === 'no_impulse' &&
      isImpulseContinuationReason(setup.reason)
    ) {
      return null;
    }
    if (continuationPolicy === 'narrow_midleg') {
      if (armed && setup.kind === 'CONTINUATION') {
        if (!isNarrowMidlegContinuation(setup, structure, minutes)) return null;
      } else {
        return null;
      }
    }
  }

  if (entryFightsStickyTrend(entry.direction, minutes)) return null;
  if (structureBlocksEntry(entry.direction, structure, entry.setup)) return null;
  if (!skipAgainstMove && entryAgainstMarketMove(entry.direction, minutes, entry.setup)) {
    return null;
  }
  if (!skipCandleConfirm) {
    // Soft on mid-swing / mid-leg CONT — pause doji after dump must not block forever
    const softCandle =
      (entry.setup === 'CONTINUATION' || entry.setup === 'BREAKOUT') &&
      isSoftCandleSetupReason(setup.reason);
    const candleDeny = entryCandleConfirmDeny(entry.direction, minutes, {
      soft: softCandle,
    });
    if (candleDeny) return null;
  }
  return entry;
}

export function playbookFromSetup(setup: MarketSetup | null | undefined): TradePlaybook | null {
  if (!setup || setup.kind === 'NONE') return null;
  return setup.playbook;
}

export function setupCatalog() {
  return SETUP_KINDS.map((k) => ({ name: k }));
}
