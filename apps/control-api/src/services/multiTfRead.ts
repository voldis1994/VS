/**
 * Multi-timeframe market read — how a desk trader actually looks at Capital:
 * 30m weather → 15m wind → 5m wave → 1m trigger.
 *
 * Higher TF sets the side. Lower TF times the entry. Fight = WAIT.
 */
export type TfDir = 'UP' | 'DOWN' | 'FLAT';

export type TfCandle = {
  open: number;
  high: number;
  low: number;
  close: number;
};

export type MultiTfStack = {
  tf30: TfDir;
  tf15: TfDir;
  tf5: TfDir;
  tf1: TfDir;
  /** Dominant side from the stack, or FLAT when mixed/unclear */
  bias: TfDir;
  /** True when higher TFs agree and 1m does not fight them */
  aligned: boolean;
  /** Human one-liner for LIVE LOG */
  summary: string;
  /** Latvian thesis fragment */
  thesis_lv: string;
};

function candleDir(c: TfCandle | null | undefined): TfDir {
  if (!c || !Number.isFinite(c.open) || !Number.isFinite(c.close)) return 'FLAT';
  if (c.close > c.open) return 'UP';
  if (c.close < c.open) return 'DOWN';
  return 'FLAT';
}

/** Last fully closed candle — drop forming tip when ≥2 present. */
export function lastClosedTfCandle(candles: TfCandle[] | null | undefined): TfCandle | null {
  if (!candles?.length) return null;
  if (candles.length >= 2) return candles[candles.length - 2]!;
  return candles[candles.length - 1]!;
}

export function dirFromCandles(candles: TfCandle[] | null | undefined): TfDir {
  return candleDir(lastClosedTfCandle(candles));
}

/**
 * Trek bias over last N closed candles (color majority + net path).
 */
export function trekBiasFromCandles(
  candles: TfCandle[] | null | undefined,
  lookback = 4
): TfDir {
  if (!candles?.length) return 'FLAT';
  const closed =
    candles.length >= 2 ? candles.slice(0, -1) : candles;
  const window = closed.slice(-Math.max(2, lookback));
  if (window.length < 2) return candleDir(window[0]);

  let up = 0;
  let down = 0;
  for (const c of window) {
    if (c.close > c.open) up += 1;
    else if (c.close < c.open) down += 1;
  }
  const first = window[0]!;
  const last = window[window.length - 1]!;
  const net = last.close - first.open;
  const trek =
    Math.max(...window.map((c) => c.high)) - Math.min(...window.map((c) => c.low));
  const mid = Math.abs(last.close) || 1;
  if (trek < Math.max(mid * 0.0004, 0.5)) return 'FLAT';
  if (up > down && net >= 0) return 'UP';
  if (down > up && net <= 0) return 'DOWN';
  if (net > 0 && up >= down) return 'UP';
  if (net < 0 && down >= up) return 'DOWN';
  return 'FLAT';
}

function arrow(d: TfDir): string {
  if (d === 'UP') return '↑';
  if (d === 'DOWN') return '↓';
  return '→';
}

/**
 * Build the desk stack. Prefer Capital candles; callers fill FLAT when missing.
 *
 * Rule a human uses:
 * - 30m + 15m set the working side
 * - 5m should agree (or be FLAT)
 * - 1m is the trigger — may be FLAT while waiting for pullback
 * - Never fade a clear higher-TF impulse on a lone 1m flicker
 */
export function readMultiTfStack(input: {
  tf30?: TfDir | null;
  tf15?: TfDir | null;
  tf5?: TfDir | null;
  tf1?: TfDir | null;
}): MultiTfStack {
  const tf30 = (input.tf30 || 'FLAT') as TfDir;
  const tf15 = (input.tf15 || 'FLAT') as TfDir;
  const tf5 = (input.tf5 || 'FLAT') as TfDir;
  const tf1 = (input.tf1 || 'FLAT') as TfDir;

  let bias: TfDir = 'FLAT';
  // Top-down: 30m leads, 15m confirms, else 5m, else 1m alone
  if (tf30 !== 'FLAT' && (tf15 === tf30 || tf15 === 'FLAT')) {
    bias = tf30;
  } else if (tf30 !== 'FLAT' && tf15 !== 'FLAT' && tf30 === tf15) {
    bias = tf30;
  } else if (tf15 !== 'FLAT' && (tf5 === tf15 || tf5 === 'FLAT')) {
    bias = tf15;
  } else if (tf5 !== 'FLAT' && tf1 === tf5) {
    bias = tf5;
  } else if (tf30 === tf15 && tf30 !== 'FLAT') {
    bias = tf30;
  } else if (
    tf1 !== 'FLAT' &&
    tf5 === 'FLAT' &&
    tf15 === 'FLAT' &&
    tf30 === 'FLAT'
  ) {
    // Only 1m visible (seed / Capital higher TF not yet fetched) — follow the tape
    bias = tf1;
  }

  const higherFight =
    (tf30 === 'UP' && tf15 === 'DOWN') || (tf30 === 'DOWN' && tf15 === 'UP');
  const midFight =
    bias !== 'FLAT' && tf5 !== 'FLAT' && tf5 !== bias;
  const triggerFight =
    bias !== 'FLAT' && tf1 !== 'FLAT' && tf1 !== bias && tf5 === bias;
  const only1m =
    tf1 !== 'FLAT' && tf5 === 'FLAT' && tf15 === 'FLAT' && tf30 === 'FLAT';

  // Aligned = higher clear, 5m not fighting, 1m not fighting hard against
  // (or only 1m available — still a usable read)
  const aligned =
    bias !== 'FLAT' &&
    !higherFight &&
    !midFight &&
    (only1m ||
      !(bias !== 'FLAT' && tf1 !== 'FLAT' && tf1 !== bias && tf5 !== 'FLAT' && tf5 !== bias));

  const summary = `30m${arrow(tf30)} 15m${arrow(tf15)} 5m${arrow(tf5)} 1m${arrow(tf1)}`;

  let thesis_lv: string;
  if (higherFight) {
    thesis_lv = `30m ${tf30} pret 15m ${tf15} — lielie TF nesakrīt, gaidu.`;
  } else if (bias === 'UP') {
    thesis_lv = midFight
      ? `30/15m UP, bet 5m DOWN — gaidu 5m atgriešanos pirms BUY.`
      : triggerFight
        ? `Augšējie TF UP · 1m vēl DOWN (pullback) — gaidu 1m zaļu / HOLD pusi BUY.`
        : `Steks UP (${summary}) — strādāju kā pircējs.`;
  } else if (bias === 'DOWN') {
    thesis_lv = midFight
      ? `30/15m DOWN, bet 5m UP — gaidu 5m atgriešanos pirms SELL.`
      : triggerFight
        ? `Augšējie TF DOWN · 1m vēl UP (rally fade gaida) — gaidu 1m sarkanu / HOLD pusi SELL.`
        : `Steks DOWN (${summary}) — strādāju kā pārdevējs.`;
  } else {
    thesis_lv = `Steks jauktā (${summary}) — nav skaidras puses.`;
  }

  return {
    tf30,
    tf15,
    tf5,
    tf1,
    bias,
    aligned: aligned && !higherFight,
    summary,
    thesis_lv,
  };
}

/** Resolve side from stack for entry mind — WAIT when not aligned. */
export function sideFromMultiTf(stack: MultiTfStack): 'BUY' | 'SELL' | 'WAIT' {
  if (stack.bias === 'FLAT') return 'WAIT';
  if (!stack.aligned) {
    // Pullback case: higher bias clear, 1m against = still hold the side (wait for trigger)
    // but don't flip. Mid fight (5m against) = WAIT.
    if (
      (stack.tf30 === stack.bias || stack.tf15 === stack.bias) &&
      stack.tf5 === stack.bias
    ) {
      return stack.bias === 'UP' ? 'BUY' : 'SELL';
    }
    return 'WAIT';
  }
  return stack.bias === 'UP' ? 'BUY' : 'SELL';
}
