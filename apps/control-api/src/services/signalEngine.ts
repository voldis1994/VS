/**
 * Multi-scale regime signal engine (Units 1–29).
 * Primary classifier for 10s OHLC — production, not a preview mode.
 */
import type { TenSecBar } from './tenSecondOhlc.js';

/** Matches operating regime names from regimes.ts (avoids circular import). */
export type OperatingRegime =
  | 'RANGE'
  | 'TREND_UP'
  | 'TREND_DOWN'
  | 'PULLBACK_UPTREND'
  | 'PULLBACK_DOWNTREND'
  | 'COMPRESSION'
  | 'EXPANSION'
  | 'BREAKOUT_UP'
  | 'BREAKOUT_DOWN'
  | 'FAILED_BREAKOUT_UP'
  | 'FAILED_BREAKOUT_DOWN'
  | 'REVERSAL_CANDIDATE';

export const SIGNAL_SCALES = [16, 32, 64, 128] as const;
export type SignalScale = (typeof SIGNAL_SCALES)[number];

export const MACRO_REGIMES = ['TREND', 'TRANSITION', 'SIDEWAYS', 'BREAKOUT'] as const;
export type MacroRegime = (typeof MACRO_REGIMES)[number];

const L = 256;
const K_LAG = 4;
const EPS = 1e-10;
const FEATURES = ['T', 'VR', 'H', 'PE', 'AC'] as const;
type FeatureKey = (typeof FEATURES)[number];
const PE_M = 3;
const PE_FACTORIAL = 6; // 3!
const HURST_Q = [2, 4, 8] as const;

const W: Record<SignalScale, number> = { 16: 1, 32: 1, 64: 1, 128: 1 };

export type ScaleSignals = {
  T: number;
  VR: number;
  H: number;
  PE: number;
  AC: number;
  Z_T: number;
  Z_VR: number;
  Z_H: number;
  Z_PE: number;
  Z_AC: number;
  ZW_T: number;
  ZW_VR: number;
  ZW_H: number;
  ZW_PE: number;
  ZW_AC: number;
  V_T: number;
  V_VR: number;
  V_H: number;
  V_PE: number;
  V_AC: number;
  TI: number;
  D: number;
  Dv: number;
  CP: number;
  MR: number;
  TRANS: number;
  SIDE: number;
  DIR: number;
  UP: number;
  DOWN: number;
};

export type SignalOutput = {
  macro: MacroRegime;
  regime: OperatingRegime;
  confidence: number;
  direction: number;
  p_trend: number;
  p_transition: number;
  p_sideways: number;
  p_breakout: number;
  ti: number;
  trans: number;
  side: number;
  mr: number;
  cp: number;
  breakout: number;
  early_side: number;
  mature_side: number;
  prop_side: number;
  prop_trans: number;
  side_start: boolean;
  side_confirmed: boolean;
  side_end: boolean;
  by_scale: Record<SignalScale, ScaleSignals>;
  bar_count: number;
  ready: boolean;
};

type RawFeatures = Record<FeatureKey, number>;

function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
}

function covariance(xs: number[], ys: number[]): number {
  if (xs.length < 2 || xs.length !== ys.length) return 0;
  const mx = mean(xs);
  const my = mean(ys);
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += (xs[i]! - mx) * (ys[i]! - my);
  return s / (xs.length - 1);
}

function std(xs: number[]): number {
  return Math.sqrt(Math.max(0, variance(xs)));
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function mad(xs: number[], med: number): number {
  if (!xs.length) return 0;
  return median(xs.map((x) => Math.abs(x - med)));
}

function sigmoid(x: number): number {
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

function clip(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function rollingPercentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const idx = clip(Math.floor(p * (s.length - 1)), 0, s.length - 1);
  return s[idx]!;
}

function robustZ(x: number, hist: number[]): number {
  const window = hist.slice(-L);
  if (window.length < 8) return 0;
  const med = median(window);
  const m = mad(window, med);
  const z = (x - med) / (1.4826 * m + EPS);
  return clip(z, -4, 4);
}

/** Bandt–Pompe ordinal pattern index in [0, m!-1] for m=3. */
function ordinalPattern3(a: number, b: number, c: number): number {
  const x = [a, b, c];
  const tie = (i: number, j: number) =>
    x[i]! === x[j]! ? i - j : x[i]! - x[j]!;
  let pattern = 0;
  let smaller = 0;
  for (let k = 1; k < 3; k++) if (tie(k, 0) < 0) smaller++;
  pattern += smaller * 2;
  if (tie(2, 1) < 0) pattern += 1;
  return pattern;
}

function safeNum(x: number, fallback = 0): number {
  return Number.isFinite(x) ? x : fallback;
}

function unit1Trend(logP: number[], t: number, n: number): { beta: number; se: number; T: number } {
  const start = t - n + 1;
  if (start < 0 || n < 3) return { beta: 0, se: 1, T: 0 };
  let sumI = 0;
  let sumP = 0;
  let sumIP = 0;
  let sumI2 = 0;
  for (let i = 0; i < n; i++) {
    const p = logP[start + i]!;
    sumI += i;
    sumP += p;
    sumIP += i * p;
    sumI2 += i * i;
  }
  const meanI = sumI / n;
  const meanP = sumP / n;
  const covIP = sumIP / n - meanI * meanP;
  let varI = 0;
  for (let i = 0; i < n; i++) varI += (i - meanI) ** 2;
  varI /= n;
  const beta = covIP / (varI + EPS);
  const alpha = meanP - beta * meanI;
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const e = logP[start + i]! - alpha - beta * i;
    sse += e * e;
  }
  const sigmaE = Math.sqrt(sse / Math.max(1, n - 2));
  let sumDev2 = 0;
  for (let i = 0; i < n; i++) sumDev2 += (i - meanI) ** 2;
  const se = sigmaE / (Math.sqrt(Math.max(sumDev2, EPS)) + EPS);
  const T = Math.abs(beta) / (se + EPS);
  return { beta, se, T };
}

function unit2VR(rets: number[], t: number, n: number): number {
  const start = t - n + 1;
  if (start < 0) return 1;
  const q = Math.max(2, Math.round(Math.sqrt(n)));
  const window = rets.slice(start, t + 1);
  if (window.length < q + 1) return 1;
  const agg: number[] = [];
  for (let i = q - 1; i < window.length; i++) {
    let s = 0;
    for (let j = 0; j < q; j++) s += window[i - j]!;
    agg.push(s);
  }
  if (agg.length < 2) return 1;
  return variance(agg) / (q * variance(window) + EPS);
}

function unit3Hurst(logP: number[], t: number, n: number): number {
  const start = t - n + 1;
  if (start < 0) return 0.5;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const q of HURST_Q) {
    if (q >= n) continue;
    const diffs: number[] = [];
    for (let i = start + q; i <= t; i++) diffs.push(logP[i]! - logP[i - q]!);
    if (diffs.length < 2) continue;
    const v = Math.max(variance(diffs), EPS);
    xs.push(Math.log(q));
    ys.push(Math.log(v));
  }
  if (xs.length < 2) return 0.5;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  const h = den > EPS ? num / den : 0;
  return h / 2;
}

function unit4PE(rets: number[], t: number, n: number): number {
  const start = t - n + 1;
  if (start < 2) return 1;
  const counts = new Array(PE_FACTORIAL).fill(0);
  let total = 0;
  for (let i = Math.max(start + 2, 2); i <= t; i++) {
    const pat = ordinalPattern3(rets[i - 2]!, rets[i - 1]!, rets[i]!);
    counts[pat] += 1;
    total += 1;
  }
  if (total === 0) return 1;
  let ent = 0;
  for (const c of counts) {
    if (c <= 0) continue;
    const p = c / total;
    ent -= p * Math.log(p);
  }
  return ent / Math.log(PE_FACTORIAL);
}

function unit5AC(rets: number[], t: number, n: number): number {
  const start = t - n + 1;
  if (start < 1) return 0;
  const r0: number[] = [];
  const r1: number[] = [];
  for (let i = start + 1; i <= t; i++) {
    r0.push(rets[i]!);
    r1.push(rets[i - 1]!);
  }
  if (r0.length < 2) return 0;
  return covariance(r0, r1) / (std(r0) * std(r1) + EPS);
}

function computeRaw(logP: number[], rets: number[], t: number, n: number): RawFeatures {
  const tr = unit1Trend(logP, t, n);
  return {
    T: tr.T,
    VR: unit2VR(rets, t, n),
    H: unit3Hurst(logP, t, n),
    PE: unit4PE(rets, t, n),
    AC: unit5AC(rets, t, n),
  };
}

function cholesky5(m: number[][]): number[][] | null {
  const n = 5;
  const L: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = 0;
      for (let k = 0; k < j; k++) s += L[i]![k]! * L[j]![k]!;
      if (i === j) {
        const v = m[i]![i]! - s;
        if (v <= EPS) return null;
        L[i]![j] = Math.sqrt(v);
      } else {
        L[i]![j] = (m[i]![j]! - s) / (L[j]![j]! + EPS);
      }
    }
  }
  return L;
}

function solveLower(L: number[][], b: number[]): number[] {
  const n = b.length;
  const x = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = b[i]!;
    for (let j = 0; j < i; j++) s -= L[i]![j]! * x[j]!;
    x[i] = s / (L[i]![i]! + EPS);
  }
  return x;
}

function covMatrix(vectors: number[][]): number[][] {
  const d = vectors[0]?.length ?? 0;
  const n = vectors.length;
  const mu = new Array(d).fill(0);
  for (const v of vectors) for (let i = 0; i < d; i++) mu[i] += v[i]!;
  for (let i = 0; i < d; i++) mu[i] /= Math.max(1, n);
  const m = Array.from({ length: d }, () => new Array(d).fill(0));
  for (const v of vectors) {
    for (let i = 0; i < d; i++) {
      for (let j = 0; j < d; j++) m[i]![j] += (v[i]! - mu[i]!) * (v[j]! - mu[j]!);
    }
  }
  const denom = Math.max(1, n - 1);
  for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) m[i]![j] /= denom;
  return m;
}

function invert5(m: number[][]): number[][] | null {
  const n = 5;
  const aug = Array.from({ length: n }, (_, i) => [...m[i]!, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row]![col]!) > Math.abs(aug[pivot]![col]!)) pivot = row;
    }
    [aug[col], aug[pivot]] = [aug[pivot]!, aug[col]!];
    const div = aug[col]![col]!;
    if (Math.abs(div) < EPS) return null;
    for (let j = 0; j < 2 * n; j++) aug[col]![j]! /= div;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const f = aug[row]![col]!;
      for (let j = 0; j < 2 * n; j++) aug[row]![j]! -= f * aug[col]![j]!;
    }
  }
  return aug.map((row) => row.slice(n));
}

function whiten(z: number[], history: number[][]): number[] {
  if (history.length < 12) return [...z];
  const sigma = covMatrix(history);
  for (let i = 0; i < 5; i++) sigma[i]![i]! += EPS;
  const L = cholesky5(sigma);
  if (!L) return [...z];
  return solveLower(L, z);
}

function mahalanobis(delta: number[], sigma: number[][]): number {
  const inv = invert5(sigma);
  if (!inv) return 0;
  let md2 = 0;
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) md2 += delta[i]! * inv[i]![j]! * delta[j]!;
  }
  return Math.sqrt(Math.max(0, md2));
}

function emptyScale(): ScaleSignals {
  return {
    T: 0,
    VR: 1,
    H: 0.5,
    PE: 1,
    AC: 0,
    Z_T: 0,
    Z_VR: 0,
    Z_H: 0,
    Z_PE: 0,
    Z_AC: 0,
    ZW_T: 0,
    ZW_VR: 0,
    ZW_H: 0,
    ZW_PE: 0,
    ZW_AC: 0,
    V_T: 0,
    V_VR: 0,
    V_H: 0,
    V_PE: 0,
    V_AC: 0,
    TI: 0.5,
    D: 0,
    Dv: 0,
    CP: 0.5,
    MR: 0.5,
    TRANS: 0.5,
    SIDE: 0.5,
    DIR: 0,
    UP: 0,
    DOWN: 0,
  };
}

function normDir(raw: number): number {
  return Math.tanh(safeNum(raw) / 5);
}

function mapMacroToRegime(
  macro: MacroRegime,
  dirRaw: number,
  prev: OperatingRegime,
  ti: number,
  side: number,
  mr: number,
  breakout: number,
  trans: number
): OperatingRegime {
  const dir = normDir(dirRaw);
  const up = dir > 0.25;
  const dn = dir < -0.25;

  // Strong trend integrity — override noisy TRANSITION macro label
  if (ti > 0.62 && trans < 0.88) {
    if (up) {
      if (prev === 'TREND_UP' && dir < 0.12 && ti > 0.45) return 'PULLBACK_UPTREND';
      return 'TREND_UP';
    }
    if (dn) {
      if (prev === 'TREND_DOWN' && dir > -0.12 && ti > 0.45) return 'PULLBACK_DOWNTREND';
      return 'TREND_DOWN';
    }
  }

  if (macro === 'BREAKOUT') {
    if (up) return 'BREAKOUT_UP';
    if (dn) return 'BREAKOUT_DOWN';
    return breakout > 0.55
      ? prev === 'BREAKOUT_DOWN'
        ? 'BREAKOUT_DOWN'
        : 'BREAKOUT_UP'
      : 'EXPANSION';
  }
  if (macro === 'TREND') {
    if (up) {
      if (prev === 'TREND_UP' && dir < 0.12 && ti > 0.45) return 'PULLBACK_UPTREND';
      return 'TREND_UP';
    }
    if (dn) {
      if (prev === 'TREND_DOWN' && dir > -0.12 && ti > 0.45) return 'PULLBACK_DOWNTREND';
      return 'TREND_DOWN';
    }
    if (prev === 'TREND_UP' || prev === 'PULLBACK_UPTREND') return 'PULLBACK_UPTREND';
    if (prev === 'TREND_DOWN' || prev === 'PULLBACK_DOWNTREND') return 'PULLBACK_DOWNTREND';
    return 'EXPANSION';
  }
  if (macro === 'SIDEWAYS') {
    if (mr > 0.65 && side > 0.6 && ti < 0.4) return 'COMPRESSION';
    return 'RANGE';
  }
  if (macro === 'TRANSITION') {
    if (up) return 'TREND_UP';
    if (dn) return 'TREND_DOWN';
    if (mr > 0.55 && side > 0.5) return 'RANGE';
    if (prev !== 'RANGE') return prev;
    return 'EXPANSION';
  }
  return 'RANGE';
}

export function computeSignalEngine(
  bars: TenSecBar[],
  previous: OperatingRegime = 'RANGE'
): SignalOutput {
  const closes = bars.map((b) => b.close).filter((c) => Number.isFinite(c) && c > 0);
  const minNeed = Math.max(...SIGNAL_SCALES) + K_LAG + 5;
  const fallback = (): SignalOutput => ({
    macro: 'SIDEWAYS',
    regime: closes.length < 2 ? 'RANGE' : previous,
    confidence: 0.2,
    direction: 0,
    p_trend: 0.25,
    p_transition: 0.25,
    p_sideways: 0.25,
    p_breakout: 0.25,
    ti: 0.5,
    trans: 0.5,
    side: 0.5,
    mr: 0.5,
    cp: 0.5,
    breakout: 0.5,
    early_side: 0.5,
    mature_side: 0.5,
    prop_side: 0,
    prop_trans: 0,
    side_start: false,
    side_confirmed: false,
    side_end: false,
    by_scale: { 16: emptyScale(), 32: emptyScale(), 64: emptyScale(), 128: emptyScale() },
    bar_count: closes.length,
    ready: false,
  });

  if (closes.length < minNeed) return fallback();

  const logP = closes.map(Math.log);
  const rets: number[] = [0];
  for (let i = 1; i < logP.length; i++) rets.push(logP[i]! - logP[i - 1]!);

  type Hist = {
    raw: Record<FeatureKey, number[]>;
    Z: number[][];
    ZW: number[][];
    TI: number[];
    D: number[];
    MD: number[];
  };

  const hist: Record<SignalScale, Hist> = {
    16: { raw: { T: [], VR: [], H: [], PE: [], AC: [] }, Z: [], ZW: [], TI: [], D: [], MD: [] },
    32: { raw: { T: [], VR: [], H: [], PE: [], AC: [] }, Z: [], ZW: [], TI: [], D: [], MD: [] },
    64: { raw: { T: [], VR: [], H: [], PE: [], AC: [] }, Z: [], ZW: [], TI: [], D: [], MD: [] },
    128: { raw: { T: [], VR: [], H: [], PE: [], AC: [] }, Z: [], ZW: [], TI: [], D: [], MD: [] },
  };

  const scaleOut: Record<SignalScale, ScaleSignals> = {
    16: emptyScale(),
    32: emptyScale(),
    64: emptyScale(),
    128: emptyScale(),
  };

  let agg = {
    ti: 0.5,
    trans: 0.5,
    side: 0.5,
    mr: 0.5,
    cp: 0.5,
    breakout: 0.5,
    early_side: 0.5,
    mature_side: 0.5,
    prop_side: 0,
    prop_trans: 0,
    p_trend: 0.25,
    p_transition: 0.25,
    p_sideways: 0.25,
    p_breakout: 0.25,
    macro: 'SIDEWAYS' as MacroRegime,
    direction: 0,
    side_start: false,
    side_confirmed: false,
    side_end: false,
    tiLag: 0.5,
  };

  const wSum = W[16] + W[32] + W[64] + W[128];

  for (let t = minNeed; t < closes.length; t++) {
    for (const n of SIGNAL_SCALES) {
      if (t < n) continue;
      const h = hist[n];
      const raw = computeRaw(logP, rets, t, n);
      for (const f of FEATURES) h.raw[f].push(raw[f]);

      const Z = FEATURES.map((f) => robustZ(raw[f], h.raw[f]));
      h.Z.push(Z);

      const ZW = whiten(Z, h.Z.slice(-Math.min(L, h.Z.length)));
      h.ZW.push(ZW);

      const lagK = h.Z.length > K_LAG ? h.Z.length - 1 - K_LAG : -1;
      const lag2K = h.Z.length > 2 * K_LAG ? h.Z.length - 1 - 2 * K_LAG : -1;
      const V = Z.map((z, i) => (lagK >= 0 ? z - h.Z[lagK]![i]! : 0));
      const Vlag = h.Z.length > K_LAG ? h.Z[h.Z.length - 1 - K_LAG]!.map((_, i) =>
        lagK >= 0 ? h.Z[lagK]![i]! - (lag2K >= 0 ? h.Z[lag2K]![i]! : 0) : 0
      ) : [0, 0, 0, 0, 0];

      const tr = unit1Trend(logP, t, n);
      const dir = tr.beta / (tr.se + EPS);

      const rawTI =
        ZW[0]! + ZW[1]! + ZW[2]! - ZW[3]! + Math.abs(ZW[4]!);
      const ti = sigmoid(rawTI);
      h.TI.push(ti);

      const dLag = h.TI.length > K_LAG ? h.TI[h.TI.length - 1 - K_LAG]! : ti;
      const D = dLag - ti;
      h.D.push(D);
      const dLag2 = h.D.length > K_LAG ? h.D[h.D.length - 1 - K_LAG]! : D;
      const Dv = dLag2 - D;

      const tiHist = h.TI.slice(-L);
      const p70 = rollingPercentile(tiHist, 0.7);
      const trendIdx: number[] = [];
      for (let j = 0; j < h.TI.length; j++) {
        if (h.TI[j]! > p70) trendIdx.push(j);
      }
      const trendVecs =
        trendIdx.length >= 8
          ? trendIdx.map((j) => h.Z[j]!)
          : h.Z.slice(-Math.min(L, h.Z.length));
      const muTrend = new Array(5).fill(0);
      for (const v of trendVecs) for (let i = 0; i < 5; i++) muTrend[i] += v[i]!;
      for (let i = 0; i < 5; i++) muTrend[i] /= Math.max(1, trendVecs.length);
      const delta = Z.map((z, i) => z - muTrend[i]!);
      let sigmaTrend = covMatrix(trendVecs);
      for (let i = 0; i < 5; i++) sigmaTrend[i]![i]! += EPS;
      const md = mahalanobis(delta, sigmaTrend);
      h.MD.push(md);
      const medMd = median(h.MD.slice(-L));
      const madMd = mad(h.MD.slice(-L), medMd);
      const cp = sigmoid((md - medMd) / (1.4826 * madMd + EPS));

      const rawMR = -Z[1]! - Z[2]! - Z[4]! + Z[3]! - Z[0]!;
      const mr = sigmoid(rawMR);

      const rawTrans =
        cp +
        D +
        Math.max(0, -V[0]!) +
        Math.max(0, -V[1]!) +
        Math.max(0, -V[2]!) +
        Math.max(0, V[3]!) +
        Math.max(0, Dv);
      const trans = sigmoid(rawTrans);

      const rawSide = mr + cp + trans - ti;
      const side = sigmoid(rawSide);

      scaleOut[n] = {
        T: safeNum(raw.T),
        VR: safeNum(raw.VR, 1),
        H: safeNum(raw.H, 0.5),
        PE: safeNum(raw.PE, 1),
        AC: safeNum(raw.AC),
        Z_T: safeNum(Z[0]!),
        Z_VR: safeNum(Z[1]!),
        Z_H: safeNum(Z[2]!),
        Z_PE: safeNum(Z[3]!),
        Z_AC: safeNum(Z[4]!),
        ZW_T: safeNum(ZW[0]!),
        ZW_VR: safeNum(ZW[1]!),
        ZW_H: safeNum(ZW[2]!),
        ZW_PE: safeNum(ZW[3]!),
        ZW_AC: safeNum(ZW[4]!),
        V_T: safeNum(V[0]!),
        V_VR: safeNum(V[1]!),
        V_H: safeNum(V[2]!),
        V_PE: safeNum(V[3]!),
        V_AC: safeNum(V[4]!),
        TI: safeNum(ti, 0.5),
        D: safeNum(D),
        Dv: safeNum(Dv),
        CP: safeNum(cp, 0.5),
        MR: safeNum(mr, 0.5),
        TRANS: safeNum(trans, 0.5),
        SIDE: safeNum(side, 0.5),
        DIR: safeNum(dir),
        UP: Math.max(0, safeNum(dir)),
        DOWN: Math.max(0, -safeNum(dir)),
      };
    }

    const ti =
      (W[16] * scaleOut[16].TI +
        W[32] * scaleOut[32].TI +
        W[64] * scaleOut[64].TI +
        W[128] * scaleOut[128].TI) /
      wSum;
    const trans =
      (W[16] * scaleOut[16].TRANS +
        W[32] * scaleOut[32].TRANS +
        W[64] * scaleOut[64].TRANS +
        W[128] * scaleOut[128].TRANS) /
      wSum;
    const side =
      (W[16] * scaleOut[16].SIDE +
        W[32] * scaleOut[32].SIDE +
        W[64] * scaleOut[64].SIDE +
        W[128] * scaleOut[128].SIDE) /
      wSum;
    const mr =
      (W[16] * scaleOut[16].MR +
        W[32] * scaleOut[32].MR +
        W[64] * scaleOut[64].MR +
        W[128] * scaleOut[128].MR) /
      wSum;
    const cp =
      (W[16] * scaleOut[16].CP +
        W[32] * scaleOut[32].CP +
        W[64] * scaleOut[64].CP +
        W[128] * scaleOut[128].CP) /
      wSum;

    const shortSide = (scaleOut[16].SIDE + scaleOut[32].SIDE) / 2;
    const longSide = (scaleOut[64].SIDE + scaleOut[128].SIDE) / 2;
    const shortTrans = (scaleOut[16].TRANS + scaleOut[32].TRANS) / 2;
    const longTrans = (scaleOut[64].TRANS + scaleOut[128].TRANS) / 2;
    const propSide = shortSide - longSide;
    const propTrans = shortTrans - longTrans;

    const earlySide = sigmoid(
      trans + cp + mr + Math.max(0, propSide) + Math.max(0, propTrans) - ti
    );
    const matureSide = sigmoid(side + mr - ti - Math.abs(propSide));

    const breakout = sigmoid(ti + Math.max(0, -propSide) - side - mr);

    const sTrend = ti * (1 - trans) * (1 - side);
    const sTransition = trans * cp;
    const sSideways = side * mr;
    const sBreakout = breakout * cp;
    const total = sTrend + sTransition + sSideways + sBreakout + EPS;

    const pTrend = sTrend / total;
    const pTransition = sTransition / total;
    const pSideways = sSideways / total;
    const pBreakout = sBreakout / total;

    const probs = [
      { k: 'TREND' as MacroRegime, p: pTrend },
      { k: 'TRANSITION' as MacroRegime, p: pTransition },
      { k: 'SIDEWAYS' as MacroRegime, p: pSideways },
      { k: 'BREAKOUT' as MacroRegime, p: pBreakout },
    ].sort((a, b) => b.p - a.p);

    const direction =
      (W[16] * scaleOut[16].DIR +
        W[32] * scaleOut[32].DIR +
        W[64] * scaleOut[64].DIR +
        W[128] * scaleOut[128].DIR) /
      wSum;

    const tiLag = hist[64].TI.length > K_LAG ? hist[64].TI[hist[64].TI.length - 1 - K_LAG]! : ti;

    agg = {
      ti,
      trans,
      side,
      mr,
      cp,
      breakout,
      early_side: earlySide,
      mature_side: matureSide,
      prop_side: propSide,
      prop_trans: propTrans,
      p_trend: pTrend,
      p_transition: pTransition,
      p_sideways: pSideways,
      p_breakout: pBreakout,
      macro: probs[0]!.k,
      direction,
      tiLag,
      side_start:
        pTransition > pTrend && earlySide > matureSide && propSide > 0 && ti < tiLag,
      side_confirmed: pSideways > pTransition && pSideways > pTrend && mr > ti,
      side_end: pBreakout > pSideways && ti > tiLag && propSide < 0,
    };
  }

  const sorted = [
    safeNum(agg.p_trend),
    safeNum(agg.p_transition),
    safeNum(agg.p_sideways),
    safeNum(agg.p_breakout),
  ].sort((a, b) => b - a);
  const confidence = clip(sorted[0]! - (sorted[1] ?? 0), 0.05, 0.98);

  const regime = mapMacroToRegime(
    agg.macro,
    agg.direction,
    previous,
    agg.ti,
    agg.side,
    agg.mr,
    agg.breakout,
    agg.trans
  );

  return {
    macro: agg.macro,
    regime,
    confidence,
    direction: normDir(agg.direction),
    p_trend: agg.p_trend,
    p_transition: agg.p_transition,
    p_sideways: agg.p_sideways,
    p_breakout: agg.p_breakout,
    ti: agg.ti,
    trans: agg.trans,
    side: agg.side,
    mr: agg.mr,
    cp: agg.cp,
    breakout: agg.breakout,
    early_side: agg.early_side,
    mature_side: agg.mature_side,
    prop_side: agg.prop_side,
    prop_trans: agg.prop_trans,
    side_start: agg.side_start,
    side_confirmed: agg.side_confirmed,
    side_end: agg.side_end,
    by_scale: scaleOut,
    bar_count: closes.length,
    ready: true,
  };
}
