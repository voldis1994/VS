/**
 * Regime = chart situation. Entry plan = targets + confirmations for EVERY regime.
 * Same idea as reading a Gold chart: range high/low, break+hold, trend dip/rally.
 */

export type EntryPlanTarget = {
  /** Where we want to enter (or zone to touch) */
  entry: number | null;
  /** Level that invalidates the plan */
  invalidation: number | null;
  /** Structure high (range / prior window) */
  range_high: number | null;
  /** Structure low */
  range_low: number | null;
  /** Breakout / zone line */
  break_level: number | null;
  /** Level that must hold for confirmation */
  confirm_level: number | null;
};

export type EntryConfirm = {
  id: string;
  label: string;
  ok: boolean;
};

export type EntryPlan = {
  direction: 'BUY' | 'SELL' | null;
  setup: string | null;
  /** Human line: what the regime implies and when to enter */
  plan: string;
  /** live vs feeds confirm for the planned side */
  feed_confirm: 'CONFIRM' | 'NEUTRAL' | 'FIGHT' | 'NONE';
  targets: EntryPlanTarget;
  confirms: EntryConfirm[];
  /** Compact one-liner for ticks / chain */
  target_line: string;
  confirm_line: string;
  /** How many confirms are OK */
  confirm_ok: number;
  confirm_n: number;
  /** True when every confirm is OK and side+setup are set — THIS is EntryReady */
  ready: boolean;
};

/** All confirms green + real side/setup → enter (do not sit on PLAN). */
export function entryPlanReady(plan: EntryPlan): boolean {
  if (!plan.direction) return false;
  if (!plan.setup) return false;
  if (!plan.confirms.length) return false;
  return plan.confirms.every((c) => c.ok);
}

export type PlanBar = {
  open: number;
  high: number;
  low: number;
  close: number;
};

function upper(s: string | null | undefined): string {
  return String(s || '')
    .trim()
    .toUpperCase();
}

function emptyTargets(): EntryPlanTarget {
  return {
    entry: null,
    invalidation: null,
    range_high: null,
    range_low: null,
    break_level: null,
    confirm_level: null,
  };
}

function windowBounds(bars: PlanBar[], n: number): { high: number; low: number } | null {
  const w = bars.filter((b) => b && Number.isFinite(b.high) && Number.isFinite(b.low)).slice(-n);
  if (w.length < 2) return null;
  let high = w[0]!.high;
  let low = w[0]!.low;
  for (const b of w) {
    high = Math.max(high, b.high);
    low = Math.min(low, b.low);
  }
  if (!(high > low)) return null;
  return { high, low };
}

function fmtPx(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n >= 100 ? n.toFixed(2) : n.toFixed(5);
}

/** Compare Capital live mid vs multi-feed mid: do feeds support the planned side? */
export function liveVsFeedConfirm(input: {
  direction: 'BUY' | 'SELL' | null;
  liveMid: number | null | undefined;
  feedMid: number | null | undefined;
}): EntryPlan['feed_confirm'] {
  if (!input.direction) return 'NONE';
  const live = input.liveMid;
  const feed = input.feedMid;
  if (live == null || feed == null || !Number.isFinite(live) || !Number.isFinite(feed) || live <= 0) {
    return 'NONE';
  }
  const rel = (feed - live) / live;
  if (input.direction === 'BUY') {
    if (rel >= 0.00002) return 'CONFIRM';
    if (rel <= -0.00008) return 'FIGHT';
    return 'NEUTRAL';
  }
  if (rel <= -0.00002) return 'CONFIRM';
  if (rel >= 0.00008) return 'FIGHT';
  return 'NEUTRAL';
}

function lastBar(bars: PlanBar[]): PlanBar | null {
  for (let i = bars.length - 1; i >= 0; --i) {
    const b = bars[i];
    if (b && Number.isFinite(b.close)) return b;
  }
  return null;
}

/**
 * From regime + bias + bars: entry family, targets (range H/L, break, confirm), and confirms.
 * Covers ALL regimes: RANGE, TREND_*, BREAKOUT_*, PULLBACK_*, EXPANSION, COMPRESSION,
 * FAILED_BREAKOUT_*, REVERSAL_CANDIDATE, TRANSITION, UNKNOWN.
 */
export function regimeEntryPlan(input: {
  regime?: string | null;
  bias?: string | null;
  liveMid?: number | null;
  feedMid?: number | null;
  /** Recent 10s bars (preferred for scalp structure) */
  bars10s?: PlanBar[] | null;
  /** 1m bars for lasting structure */
  bars1m?: PlanBar[] | null;
}): EntryPlan {
  const r = upper(input.regime);
  const bias = upper(input.bias);
  const live = input.liveMid != null && Number.isFinite(input.liveMid) ? input.liveMid : null;
  const bars10 = (input.bars10s || []).filter((b) => b && Number.isFinite(b.close));
  const bars1m = (input.bars1m || []).filter((b) => b && Number.isFinite(b.close));
  const struct = windowBounds(bars10.length >= 4 ? bars10 : bars1m, bars10.length >= 4 ? 18 : 20);
  const wider = windowBounds(bars1m.length >= 8 ? bars1m : bars10, 40) || struct;
  const cur = lastBar(bars10) || lastBar(bars1m);
  const mid = live ?? cur?.close ?? null;

  let direction: 'BUY' | 'SELL' | null = null;
  let setup: string | null = null;
  let plan = `regime ${r || 'UNKNOWN'} · no actionable entry plan yet`;
  const targets = emptyTargets();
  if (struct) {
    targets.range_high = struct.high;
    targets.range_low = struct.low;
  } else if (wider) {
    targets.range_high = wider.high;
    targets.range_low = wider.low;
  }

  const rh = targets.range_high;
  const rl = targets.range_low;
  const span = rh != null && rl != null ? rh - rl : null;

  // --- ALL regimes: map to plan + numeric targets ---
  if (r.includes('FAILED_BREAKOUT_UP') || (r.includes('FAILED_BREAKOUT') && r.includes('UP'))) {
    direction = 'SELL';
    setup = 'FAILED_BREAKOUT';
    targets.break_level = rh;
    targets.confirm_level = rh != null && span != null ? rh - span * 0.15 : mid;
    targets.entry = targets.confirm_level;
    targets.invalidation = rh != null && span != null ? rh + span * 0.05 : null;
    plan = 'FAILED_BREAKOUT_UP · target: hold below break · fade SELL';
  } else if (
    r.includes('FAILED_BREAKOUT_DOWN') ||
    (r.includes('FAILED_BREAKOUT') && r.includes('DOWN'))
  ) {
    direction = 'BUY';
    setup = 'FAILED_BREAKOUT';
    targets.break_level = rl;
    targets.confirm_level = rl != null && span != null ? rl + span * 0.15 : mid;
    targets.entry = targets.confirm_level;
    targets.invalidation = rl != null && span != null ? rl - span * 0.05 : null;
    plan = 'FAILED_BREAKOUT_DOWN · target: hold above break · fade BUY';
  } else if (r === 'BREAKOUT_UP' || r.startsWith('BREAKOUT_UP')) {
    direction = 'BUY';
    setup = 'BREAKOUT';
    targets.break_level = rh;
    targets.confirm_level = rh;
    targets.entry = rh != null && span != null ? rh + span * 0.02 : mid;
    targets.invalidation = rh != null && span != null ? rh - span * 0.08 : rl;
    plan = 'BREAKOUT_UP · target: hold above range HIGH · BUY break+hold';
  } else if (r === 'BREAKOUT_DOWN' || r.startsWith('BREAKOUT_DOWN')) {
    direction = 'SELL';
    setup = 'BREAKOUT';
    targets.break_level = rl;
    targets.confirm_level = rl;
    targets.entry = rl != null && span != null ? rl - span * 0.02 : mid;
    targets.invalidation = rl != null && span != null ? rl + span * 0.08 : rh;
    plan = 'BREAKOUT_DOWN · target: hold below range LOW · SELL break+hold';
  } else if (r === 'TREND_UP' || r.startsWith('TREND_UP')) {
    direction = 'BUY';
    setup = 'PULLBACK';
    // Dip target = mid-band / prior low zone
    targets.entry = rl != null && rh != null ? rl + (rh - rl) * 0.35 : mid;
    targets.confirm_level = targets.entry;
    targets.invalidation = rl;
    targets.break_level = rh;
    plan = 'TREND_UP · target: dip toward range LOW zone · BUY PULLBACK / resume CONTINUATION';
  } else if (r === 'TREND_DOWN' || r.startsWith('TREND_DOWN')) {
    direction = 'SELL';
    setup = 'CONTINUATION';
    targets.entry = rl != null && rh != null ? rh - (rh - rl) * 0.35 : mid;
    targets.confirm_level = targets.entry;
    targets.invalidation = rh;
    targets.break_level = rl;
    plan = 'TREND_DOWN · target: rally toward range HIGH zone · SELL CONTINUATION';
  } else if (r.includes('PULLBACK_UP')) {
    direction = bias === 'DOWN' ? 'SELL' : 'BUY';
    setup = bias === 'DOWN' ? 'CONTINUATION' : 'PULLBACK';
    if (direction === 'BUY') {
      targets.entry = rl != null && rh != null ? rl + (rh - rl) * 0.4 : mid;
      targets.invalidation = rl;
      targets.confirm_level = targets.entry;
      targets.break_level = rh;
      plan = 'PULLBACK_UPTREND · target: dip-buy near LOW · confirm resume up';
    } else {
      targets.entry = mid;
      targets.invalidation = rh;
      targets.confirm_level = rl != null && rh != null ? rh - (rh - rl) * 0.2 : mid;
      targets.break_level = rl;
      plan = 'PULLBACK_UPTREND + bias DOWN · target: fail resume · SELL';
    }
  } else if (r.includes('PULLBACK_DOWN')) {
    direction = bias === 'UP' ? 'BUY' : 'SELL';
    setup = 'CONTINUATION';
    if (direction === 'SELL') {
      targets.entry = rl != null && rh != null ? rh - (rh - rl) * 0.4 : mid;
      targets.invalidation = rh;
      targets.confirm_level = targets.entry;
      targets.break_level = rl;
      plan = 'PULLBACK_DOWNTREND · target: rally-sell near HIGH · confirm resume down';
    } else {
      targets.entry = mid;
      targets.invalidation = rl;
      targets.confirm_level = rl != null && rh != null ? rl + (rh - rl) * 0.2 : mid;
      targets.break_level = rh;
      plan = 'PULLBACK_DOWNTREND + bias UP · target: reclaim · BUY';
    }
  } else if (r === 'EXPANSION' || r.startsWith('EXPANSION')) {
    if (bias === 'UP') {
      direction = 'BUY';
      setup = 'PULLBACK';
      targets.entry = rl != null && rh != null ? rl + (rh - rl) * 0.3 : mid;
      targets.invalidation = rl;
      targets.confirm_level = targets.entry;
      targets.break_level = rh;
      plan = 'EXPANSION + bias UP · target: structured dip · BUY';
    } else if (bias === 'DOWN') {
      direction = 'SELL';
      setup = 'BREAKOUT';
      targets.entry = rl != null && rh != null ? rh - (rh - rl) * 0.3 : mid;
      targets.invalidation = rh;
      targets.confirm_level = targets.entry;
      targets.break_level = rl;
      plan = 'EXPANSION + bias DOWN · target: structured dump · SELL';
    } else {
      plan = 'EXPANSION · wait bias UP/DOWN · targets = range HIGH/LOW';
      targets.break_level = rh;
      targets.confirm_level = rl;
    }
  } else if (r === 'RANGE' || r.includes('COMPRESSION')) {
    setup = 'RANGE_REJECTION';
    targets.break_level = rh;
    targets.confirm_level = rl;
    // Pick side when price is already at an edge — otherwise PLAN with no side blocks forever.
    if (rhNear(mid, targets)) {
      direction = 'SELL';
      targets.entry = rh;
      targets.invalidation = rh != null && span != null ? rh + span * 0.05 : null;
      plan = 'RANGE · at HIGH · target rejection SELL';
    } else if (rlNear(mid, targets)) {
      direction = 'BUY';
      targets.entry = rl;
      targets.invalidation = rl != null && span != null ? rl - span * 0.05 : null;
      plan = 'RANGE · at LOW · target rejection BUY';
    } else {
      direction = null;
      targets.entry = null;
      targets.invalidation = null;
      plan =
        'RANGE/COMPRESSION · targets: HIGH rejection SELL · LOW rejection BUY · break+hold → BREAKOUT';
    }
  } else if (r.includes('REVERSAL')) {
    direction = null;
    setup = 'REVERSAL';
    targets.entry = mid;
    targets.confirm_level = mid;
    targets.break_level = bias === 'UP' ? rl : bias === 'DOWN' ? rh : mid;
    targets.invalidation = bias === 'UP' ? rl : bias === 'DOWN' ? rh : null;
    plan = 'REVERSAL_CANDIDATE · target: confirm bar vs prior impulse · then FADE/REVERSAL';
  } else if (r === 'TRANSITION' || r.startsWith('TRANSITION')) {
    direction = bias === 'UP' ? 'BUY' : bias === 'DOWN' ? 'SELL' : null;
    setup = direction ? 'CONTINUATION' : null;
    targets.entry = mid;
    targets.confirm_level = mid;
    targets.break_level = direction === 'BUY' ? rh : direction === 'SELL' ? rl : null;
    targets.invalidation = direction === 'BUY' ? rl : direction === 'SELL' ? rh : null;
    plan = direction
      ? `TRANSITION + bias ${bias} · target: clear micro ${direction} · then ${setup}`
      : 'TRANSITION · wait bias / clearer structure · watch range HIGH/LOW';
  } else if (bias === 'UP') {
    direction = 'BUY';
    setup = 'CONTINUATION';
    targets.entry = mid;
    targets.confirm_level = mid;
    targets.break_level = rh;
    targets.invalidation = rl;
    plan = `${r || 'UNKNOWN'} + bias UP · target: micro climb / dip-buy · BUY`;
  } else if (bias === 'DOWN') {
    direction = 'SELL';
    setup = 'CONTINUATION';
    targets.entry = mid;
    targets.confirm_level = mid;
    targets.break_level = rl;
    targets.invalidation = rh;
    plan = `${r || 'UNKNOWN'} + bias DOWN · target: micro dump / rally-sell · SELL`;
  } else {
    // UNKNOWN / leftover — still publish structure targets
    setup = null;
    plan = `${r || 'UNKNOWN'} · watch range HIGH ${fmtPx(rh)} / LOW ${fmtPx(rl)} · wait bias`;
  }

  const feed_confirm = liveVsFeedConfirm({
    direction,
    liveMid: input.liveMid,
    feedMid: input.feedMid,
  });

  const confirms = buildConfirms({
    regime: r,
    direction,
    setup,
    mid,
    cur,
    targets,
    feed_confirm,
    bars10,
  });

  if (direction && feed_confirm === 'CONFIRM') {
    plan = `${plan} · feeds CONFIRM live`;
  } else if (direction && feed_confirm === 'FIGHT') {
    plan = `${plan} · feeds FIGHT live (wait hold)`;
  }

  const target_line = [
    `H ${fmtPx(targets.range_high)}`,
    `L ${fmtPx(targets.range_low)}`,
    targets.break_level != null ? `BRK ${fmtPx(targets.break_level)}` : null,
    targets.entry != null ? `ENT ${fmtPx(targets.entry)}` : null,
    targets.confirm_level != null ? `CFM ${fmtPx(targets.confirm_level)}` : null,
    targets.invalidation != null ? `INV ${fmtPx(targets.invalidation)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const okN = confirms.filter((c) => c.ok).length;
  const confirm_line = `${okN}/${confirms.length} confirms · ${confirms
    .map((c) => `${c.ok ? '✓' : '·'}${c.id}`)
    .join(' ')}`;

  const ready =
    Boolean(direction) &&
    Boolean(setup) &&
    confirms.length > 0 &&
    confirms.every((c) => c.ok);

  if (ready) {
    plan = `${plan} · READY ${okN}/${confirms.length} → ENTRY`;
  }

  return {
    direction,
    setup,
    plan,
    feed_confirm,
    targets,
    confirms,
    target_line,
    confirm_line,
    confirm_ok: okN,
    confirm_n: confirms.length,
    ready,
  };
}

function buildConfirms(input: {
  regime: string;
  direction: 'BUY' | 'SELL' | null;
  setup: string | null;
  mid: number | null;
  cur: PlanBar | null;
  targets: EntryPlanTarget;
  feed_confirm: EntryPlan['feed_confirm'];
  bars10: PlanBar[];
}): EntryConfirm[] {
  const { direction, mid, cur, targets, feed_confirm, bars10, regime, setup } = input;
  const out: EntryConfirm[] = [];

  out.push({
    id: 'STRUCT',
    label: 'range HIGH/LOW measured',
    ok: targets.range_high != null && targets.range_low != null,
  });

  out.push({
    id: 'FEEDS',
    label: `live vs feeds ${feed_confirm}`,
    // Soft: FIGHT is a warning, not a hard veto — structure confirms decide entry.
    ok: true,
  });

  if (direction === 'BUY') {
    const aboveBrk =
      targets.break_level != null && mid != null ? mid >= targets.break_level * 0.9997 : false;
    const nearEntry =
      targets.entry != null && mid != null
        ? Math.abs(mid - targets.entry) / Math.max(Math.abs(targets.entry), 1e-9) <= 0.0012
        : false;
    const holdInv =
      targets.invalidation != null && mid != null ? mid > targets.invalidation : true;
    if (setup === 'BREAKOUT' || regime.includes('BREAKOUT_UP')) {
      out.push({
        id: 'HOLD_ABOVE',
        label: 'hold above break/HIGH',
        ok: aboveBrk || rhNear(mid, targets),
      });
    } else if (setup === 'PULLBACK' || setup === 'RANGE_REJECTION') {
      out.push({
        id: 'NEAR_ENTRY',
        label: 'price near dip/LOW entry',
        ok: nearEntry || rlNear(mid, targets),
      });
    } else {
      out.push({ id: 'SIDE_OK', label: 'BUY side live', ok: mid != null });
    }
    out.push({ id: 'INV_OK', label: 'above invalidation', ok: holdInv });
  } else if (direction === 'SELL') {
    const belowBrk =
      targets.break_level != null && mid != null ? mid <= targets.break_level * 1.0003 : false;
    const nearEntry =
      targets.entry != null && mid != null
        ? Math.abs(mid - targets.entry) / Math.max(Math.abs(targets.entry), 1e-9) <= 0.0012
        : false;
    const holdInv =
      targets.invalidation != null && mid != null ? mid < targets.invalidation : true;
    if (setup === 'BREAKOUT' || regime.includes('BREAKOUT_DOWN')) {
      out.push({
        id: 'HOLD_BELOW',
        label: 'hold below break/LOW',
        ok: belowBrk || rlNear(mid, targets),
      });
    } else if (setup === 'PULLBACK' || setup === 'RANGE_REJECTION' || setup === 'CONTINUATION') {
      out.push({
        id: 'NEAR_ENTRY',
        label: 'price near rally/HIGH entry',
        ok: nearEntry || rhNear(mid, targets),
      });
    } else {
      out.push({ id: 'SIDE_OK', label: 'SELL side live', ok: mid != null });
    }
    out.push({ id: 'INV_OK', label: 'below invalidation', ok: holdInv });
  } else if (setup === 'RANGE_REJECTION') {
    out.push({
      id: 'AT_HIGH',
      label: 'at/near range HIGH (SELL reject)',
      ok: rhNear(mid, targets),
    });
    out.push({
      id: 'AT_LOW',
      label: 'at/near range LOW (BUY reject)',
      ok: rlNear(mid, targets),
    });
  } else {
    out.push({ id: 'BIAS', label: 'need bias UP/DOWN', ok: false });
  }

  // Micro bar confirm
  if (cur && direction === 'BUY') {
    out.push({
      id: '10s',
      label: '10s not dumping hard',
      ok: !(cur.close < cur.open && bars10.length >= 2 && cur.close < bars10[bars10.length - 2]!.close),
    });
  } else if (cur && direction === 'SELL') {
    out.push({
      id: '10s',
      label: '10s not climbing hard',
      ok: !(cur.close > cur.open && bars10.length >= 2 && cur.close > bars10[bars10.length - 2]!.close),
    });
  }

  return out;
}

function rhNear(mid: number | null, t: EntryPlanTarget): boolean {
  if (mid == null || t.range_high == null) return false;
  const span = t.range_high - (t.range_low ?? t.range_high * 0.999);
  return mid >= t.range_high - Math.max(span * 0.12, Math.abs(t.range_high) * 0.00015);
}

function rlNear(mid: number | null, t: EntryPlanTarget): boolean {
  if (mid == null || t.range_low == null) return false;
  const span = (t.range_high ?? t.range_low * 1.001) - t.range_low;
  return mid <= t.range_low + Math.max(span * 0.12, Math.abs(t.range_low) * 0.00015);
}
