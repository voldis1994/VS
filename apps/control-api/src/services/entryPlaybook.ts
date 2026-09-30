/**
 * Entry playbook router — who looks at what.
 *
 * One classifier label (esp. false RANGE) used to drive every gate. That mixed
 * Capital HTF trend, local shelf breakouts, and mid-zone fades into one pipe
 * (Gold 17:45 RANGE SELL on a sell-break).
 *
 * Lanes (mutually exclusive for setup selection):
 * - BREAKOUT     — story/live break; follow pierce, never fade
 * - TREND_PULLBACK — Capital 30/15/5 bias + dip/bounce; never RANGE half-fade
 * - RANGE_FADE   — ONLY when HTF flat/mixed AND story is chop
 * - REVERSAL     — violent flip playbook
 * - LIVE         — EXPANSION / FAILED stand as-is
 */
import { normalizeRegime, type RegimeName } from './regimes.js';
import type { MarketStory } from './marketStory.js';

export type TfBiasDir = 'UP' | 'DOWN' | 'FLAT';

export type EffectiveRegimeHtf = {
  tf30?: TfBiasDir | null;
  tf15?: TfBiasDir | null;
  tf5?: TfBiasDir | null;
  m1?: TfBiasDir | null;
};

export type PlaybookLane =
  | 'BREAKOUT'
  | 'TREND_PULLBACK'
  | 'RANGE_FADE'
  | 'REVERSAL'
  | 'LIVE';

export type EntryPlaybook = {
  lane: PlaybookLane;
  regime: RegimeName;
  why_lv: string;
};

const CHOP = new Set<RegimeName>(['RANGE', 'COMPRESSION', 'TRANSITION']);

/**
 * Capital HTF bias from 30→15→5 (m1 only when HTF empty).
 * Majority wins — one opposing TF must not freeze as MIXED.
 */
export function capitalHtfBias(htf?: EffectiveRegimeHtf | null): 'UP' | 'DOWN' | 'FLAT' | 'MIXED' {
  if (!htf) return 'FLAT';
  const stack: TfBiasDir[] = [];
  for (const d of [htf.tf30, htf.tf15, htf.tf5]) {
    if (d === 'UP' || d === 'DOWN') stack.push(d);
  }
  if (!stack.length) {
    if (htf.m1 === 'UP' || htf.m1 === 'DOWN') return htf.m1;
    return 'FLAT';
  }
  const up = stack.filter((d) => d === 'UP').length;
  const down = stack.filter((d) => d === 'DOWN').length;
  if (up > down) return 'UP';
  if (down > up) return 'DOWN';
  return 'MIXED';
}

function chapterOf(story: Pick<MarketStory, 'allow' | 'chapter'> | null | undefined): string {
  return String(story?.chapter || '').toUpperCase();
}

function allowOf(story: Pick<MarketStory, 'allow' | 'chapter'> | null | undefined): string {
  return String(story?.allow || '').toUpperCase();
}

/**
 * Pick which brain owns this bar's entry playbook.
 * Capital HTF + story chapter decide before the 10s RANGE label.
 */
export function pickEntryPlaybook(input: {
  liveRegime: RegimeName | string | null | undefined;
  story: Pick<MarketStory, 'allow' | 'chapter'> | null | undefined;
  htf?: EffectiveRegimeHtf | null;
}): EntryPlaybook {
  const live = normalizeRegime(input.liveRegime);
  const ch = chapterOf(input.story);
  const allow = allowOf(input.story);
  const bias = capitalHtfBias(input.htf);
  const m1 = input.htf?.m1;

  if (live === 'REVERSAL_CANDIDATE') {
    return { lane: 'REVERSAL', regime: live, why_lv: 'REVERSAL smadzenes · live flip' };
  }
  if (live === 'BREAKOUT_UP' || live === 'BREAKOUT_DOWN') {
    return { lane: 'BREAKOUT', regime: live, why_lv: `BREAKOUT smadzenes · live ${live}` };
  }
  if (live === 'FAILED_BREAKOUT_UP' || live === 'FAILED_BREAKOUT_DOWN') {
    return { lane: 'LIVE', regime: live, why_lv: `FAILED-BREAK smadzenes · live ${live}` };
  }
  if (live === 'EXPANSION') {
    return { lane: 'LIVE', regime: live, why_lv: 'EXPANSION smadzenes · live impulse' };
  }
  if (
    live === 'TREND_UP' ||
    live === 'TREND_DOWN' ||
    live === 'PULLBACK_UPTREND' ||
    live === 'PULLBACK_DOWNTREND'
  ) {
    return { lane: 'TREND_PULLBACK', regime: live, why_lv: `TREND smadzenes · live ${live}` };
  }

  if (ch === 'BREAK_UP') {
    return {
      lane: 'BREAKOUT',
      regime: 'BREAKOUT_UP',
      why_lv: 'BREAKOUT smadzenes · stāsts BREAK_UP (ne RANGE fade)',
    };
  }
  if (ch === 'BREAK_DOWN') {
    return {
      lane: 'BREAKOUT',
      regime: 'BREAKOUT_DOWN',
      why_lv: 'BREAKOUT smadzenes · stāsts BREAK_DOWN (ne RANGE fade)',
    };
  }

  if (bias === 'UP') {
    const regime: RegimeName =
      ch === 'DIP_IN_RALLY' || m1 === 'DOWN' ? 'PULLBACK_UPTREND' : 'TREND_UP';
    return {
      lane: 'TREND_PULLBACK',
      regime,
      why_lv: `TREND smadzenes · Capital HTF UP → ${regime}`,
    };
  }
  if (bias === 'DOWN') {
    const regime: RegimeName =
      ch === 'BOUNCE_IN_SELL' || m1 === 'UP' ? 'PULLBACK_DOWNTREND' : 'TREND_DOWN';
    return {
      lane: 'TREND_PULLBACK',
      regime,
      why_lv: `TREND smadzenes · Capital HTF DOWN → ${regime}`,
    };
  }

  if (ch === 'DIP_IN_RALLY') {
    return {
      lane: 'TREND_PULLBACK',
      regime: 'PULLBACK_UPTREND',
      why_lv: 'TREND smadzenes · DIP_IN_RALLY',
    };
  }
  if (ch === 'BOUNCE_IN_SELL') {
    return {
      lane: 'TREND_PULLBACK',
      regime: 'PULLBACK_DOWNTREND',
      why_lv: 'TREND smadzenes · BOUNCE_IN_SELL (gaida 1m confirm)',
    };
  }
  // EXHAUST tip + flat HTF: stay chop book, but entry must WAIT reject (not fade knife /
  // not fake TREND). decideEntryWithStructure blocks tip chase on this chapter.
  if (
    CHOP.has(live) &&
    (bias === 'FLAT' || bias === 'MIXED') &&
    (ch === 'EXHAUST_HI' || ch === 'EXHAUST_LO')
  ) {
    return {
      lane: 'RANGE_FADE',
      regime: live === 'TRANSITION' || live === 'COMPRESSION' ? live : 'RANGE',
      why_lv: `RANGE · ${ch} tip · gaida reject (ne fade knife / ne fake TREND)`,
    };
  }
  if (ch === 'RALLY' || ch === 'EXHAUST_HI' || allow === 'BUY') {
    return {
      lane: 'TREND_PULLBACK',
      regime: 'TREND_UP',
      why_lv: 'TREND smadzenes · stāsts BUY/RALLY',
    };
  }
  if (ch === 'SELLOFF' || ch === 'EXHAUST_LO' || allow === 'SELL') {
    return {
      lane: 'TREND_PULLBACK',
      regime: 'TREND_DOWN',
      why_lv: 'TREND smadzenes · stāsts SELL/SELLOFF',
    };
  }

  if (
    CHOP.has(live) &&
    (ch === 'RANGE_CHOP' ||
      ch === 'MIXED' ||
      ch === 'SEEDING' ||
      !ch ||
      allow === 'NONE' ||
      allow === 'BOTH')
  ) {
    return {
      lane: 'RANGE_FADE',
      regime: live === 'TRANSITION' || live === 'COMPRESSION' ? live : 'RANGE',
      why_lv: 'RANGE smadzenes · HTF flat/mixed + chop stāsts',
    };
  }

  // Uncertain HTF/story — do NOT invent RANGE fade. Keep live chop only;
  // sticky TREND/EXPANSION stays; UNKNOWN waits (ne false RANGE).
  if (CHOP.has(live)) {
    return {
      lane: 'RANGE_FADE',
      regime: live === 'TRANSITION' || live === 'COMPRESSION' ? live : 'RANGE',
      why_lv: 'RANGE smadzenes · live chop · nav skaidra HTF/stāsta',
    };
  }
  if (live === 'UNKNOWN' || live === 'TRANSITION') {
    return {
      lane: 'LIVE',
      regime: 'UNKNOWN',
      why_lv: 'WAIT · nav skaidra HTF/stāsta · ne RANGE fade',
    };
  }
  // Exhaustive early returns above — never invent RANGE on leftover live
  return {
    lane: 'LIVE',
    regime: live,
    why_lv: `promote live ${live} · nav skaidra HTF/stāsta · ne false RANGE`,
  };
}

/** Setups each lane may arm — prevents RANGE FADE on a breakout bar. */
export function setupAllowedOnLane(
  lane: PlaybookLane,
  setup: string | null | undefined
): boolean {
  const s = String(setup || '').toUpperCase();
  switch (lane) {
    case 'BREAKOUT':
      return s === 'BREAKOUT' || s === 'CONTINUATION';
    case 'TREND_PULLBACK':
      return s === 'PULLBACK' || s === 'CONTINUATION';
    case 'RANGE_FADE':
      return s === 'FADE' || s === 'CONTINUATION';
    case 'REVERSAL':
      return s === 'REVERSAL' || s === 'CONTINUATION';
    case 'LIVE':
      return true;
    default:
      return true;
  }
}
