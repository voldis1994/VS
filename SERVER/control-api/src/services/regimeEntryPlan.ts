/**
 * Regime = chart situation. Entry plan = what to do in that situation.
 * Same idea as reading a Gold 10s chart: breakout / range / hold / best entry moment.
 * Node shows the plan on the desk; C++ posts EntryReady when the moment is live.
 */

export type EntryPlan = {
  direction: 'BUY' | 'SELL' | null;
  setup: string | null;
  /** Human line: what the regime implies and when to enter */
  plan: string;
  /** live vs feeds confirm for the planned side */
  feed_confirm: 'CONFIRM' | 'NEUTRAL' | 'FIGHT' | 'NONE';
};

function upper(s: string | null | undefined): string {
  return String(s || '')
    .trim()
    .toUpperCase();
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
  // Feed above live supports BUY (public/peers already lifted); below supports SELL.
  if (input.direction === 'BUY') {
    if (rel >= 0.00002) return 'CONFIRM';
    if (rel <= -0.00008) return 'FIGHT';
    return 'NEUTRAL';
  }
  if (rel <= -0.00002) return 'CONFIRM';
  if (rel >= 0.00008) return 'FIGHT';
  return 'NEUTRAL';
}

/**
 * From regime + bias alone: what entry family and side the chart implies.
 * This is the "if it breaks / holds / rejects — where is the entry" map.
 */
export function regimeEntryPlan(input: {
  regime?: string | null;
  bias?: string | null;
  liveMid?: number | null;
  feedMid?: number | null;
}): EntryPlan {
  const r = upper(input.regime);
  const bias = upper(input.bias);
  let direction: 'BUY' | 'SELL' | null = null;
  let setup: string | null = null;
  let plan = `regime ${r || 'UNKNOWN'} · no actionable entry plan yet`;

  if (r.includes('FAILED_BREAKOUT_UP') || (r.includes('FAILED_BREAKOUT') && r.includes('UP'))) {
    direction = 'SELL';
    setup = 'FAILED_BREAKOUT';
    plan = 'FAILED_BREAKOUT_UP · break failed · fade short on rejection hold';
  } else if (r.includes('FAILED_BREAKOUT_DOWN') || (r.includes('FAILED_BREAKOUT') && r.includes('DOWN'))) {
    direction = 'BUY';
    setup = 'FAILED_BREAKOUT';
    plan = 'FAILED_BREAKOUT_DOWN · break failed · fade long on reclaim';
  } else if (r === 'BREAKOUT_UP' || r.startsWith('BREAKOUT_UP')) {
    direction = 'BUY';
    setup = 'BREAKOUT';
    plan = 'BREAKOUT_UP · zone broken up · best entry = hold above break (BUY)';
  } else if (r === 'BREAKOUT_DOWN' || r.startsWith('BREAKOUT_DOWN')) {
    direction = 'SELL';
    setup = 'BREAKOUT';
    plan = 'BREAKOUT_DOWN · zone broken down · best entry = hold below break (SELL)';
  } else if (r === 'TREND_UP' || r.startsWith('TREND_UP')) {
    direction = 'BUY';
    setup = 'PULLBACK';
    plan = 'TREND_UP · buy dips (PULLBACK) or resume after dip (CONTINUATION)';
  } else if (r === 'TREND_DOWN' || r.startsWith('TREND_DOWN')) {
    direction = 'SELL';
    setup = 'CONTINUATION';
    plan = 'TREND_DOWN · sell rallies / follow dumps (CONTINUATION)';
  } else if (r.includes('PULLBACK_UP')) {
    direction = bias === 'DOWN' ? 'SELL' : 'BUY';
    setup = bias === 'DOWN' ? 'CONTINUATION' : 'PULLBACK';
    plan =
      bias === 'DOWN'
        ? 'PULLBACK_UPTREND + bias DOWN · structure flipped · SELL continuation'
        : 'PULLBACK_UPTREND · best entry = dip-buy in up structure';
  } else if (r.includes('PULLBACK_DOWN')) {
    direction = bias === 'UP' ? 'BUY' : 'SELL';
    setup = bias === 'UP' ? 'CONTINUATION' : 'CONTINUATION';
    plan =
      bias === 'UP'
        ? 'PULLBACK_DOWNTREND + bias UP · structure flipped · BUY continuation'
        : 'PULLBACK_DOWNTREND · best entry = resume short after rally';
  } else if (r === 'EXPANSION' || r.startsWith('EXPANSION')) {
    if (bias === 'UP') {
      direction = 'BUY';
      setup = 'PULLBACK';
      plan = 'EXPANSION + bias UP · buy structured dips';
    } else if (bias === 'DOWN') {
      direction = 'SELL';
      setup = 'BREAKOUT';
      plan = 'EXPANSION + bias DOWN · follow structured dumps';
    } else {
      plan = 'EXPANSION · wait bias UP/DOWN for side';
    }
  } else if (r === 'RANGE' || r.includes('COMPRESSION')) {
    direction = null;
    setup = 'RANGE_REJECTION';
    plan = 'RANGE · best entry = rejection at edge, or break+hold → becomes BREAKOUT';
  } else if (r.includes('REVERSAL')) {
    direction = null;
    setup = 'REVERSAL';
    plan = 'REVERSAL_CANDIDATE · wait confirm bar (FADE/REVERSAL)';
  } else if (bias === 'UP') {
    direction = 'BUY';
    setup = 'CONTINUATION';
    plan = `${r || 'UNKNOWN'} + bias UP · plan BUY on micro climb / dip-buy`;
  } else if (bias === 'DOWN') {
    direction = 'SELL';
    setup = 'CONTINUATION';
    plan = `${r || 'UNKNOWN'} + bias DOWN · plan SELL on micro dump / rally-sell`;
  }

  const feed_confirm = liveVsFeedConfirm({
    direction,
    liveMid: input.liveMid,
    feedMid: input.feedMid,
  });
  if (direction && feed_confirm === 'CONFIRM') {
    plan = `${plan} · feeds CONFIRM live`;
  } else if (direction && feed_confirm === 'FIGHT') {
    plan = `${plan} · feeds FIGHT live (wait hold)`;
  }

  return { direction, setup, plan, feed_confirm };
}
