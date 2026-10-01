/**
 * Entry thesis router — one canonical regime/lane for this bar.
 *
 * Priority (clean tape read — not predict future):
 * 1. REVERSAL (V flip) / BREAKOUT / FAILED / EXPANSION — live owns
 * 2. BREAK story → BREAKOUT
 * 3. SIDE / RANGE_FADE when live chop (or sticky TREND demoted on proven chop)
 * 4. TREND/PULLBACK only on clean full HTF stack (or live TREND when not demoted)
 *
 * Genome owns promote/chop/reversal gates — brains may evolve; lot/API/system off-limits.
 */
import { getBrainGenome } from '../brainSelfImprove/brainGenome.js';
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
const TRENDISH = new Set<RegimeName>([
  'TREND_UP',
  'TREND_DOWN',
  'PULLBACK_UPTREND',
  'PULLBACK_DOWNTREND',
]);
const SIDE_STORY = new Set([
  'RANGE_CHOP',
  'MIXED',
  'SEEDING',
  '',
]);

/** 30+15+5 all present (FLAT counts; null = not loaded yet). */
export function htfStackComplete(htf?: EffectiveRegimeHtf | null): boolean {
  if (!htf) return false;
  return htf.tf30 != null && htf.tf15 != null && htf.tf5 != null;
}

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

function chopRegime(live: RegimeName): RegimeName {
  return live === 'TRANSITION' || live === 'COMPRESSION' ? live : 'RANGE';
}

function rangeFade(live: RegimeName, why_lv: string): EntryPlaybook {
  return { lane: 'RANGE_FADE', regime: chopRegime(live), why_lv };
}

function isSideStory(ch: string, allow: string): boolean {
  return (
    SIDE_STORY.has(ch) ||
    allow === 'NONE' ||
    allow === 'BOTH' ||
    ch === 'EXHAUST_HI' ||
    ch === 'EXHAUST_LO'
  );
}

/**
 * Pick the entry thesis for this bar (lane + regime).
 * Priority: REVERSAL/BREAKOUT → SIDE → TREND (clean HTF only).
 */
export function pickEntryPlaybook(input: {
  liveRegime: RegimeName | string | null | undefined;
  story: Pick<MarketStory, 'allow' | 'chapter'> | null | undefined;
  htf?: EffectiveRegimeHtf | null;
}): EntryPlaybook {
  const live = normalizeRegime(input.liveRegime);
  const ch = chapterOf(input.story);
  const allow = allowOf(input.story);
  const g = getBrainGenome();
  const stackOk = !g.playbook_require_full_htf_stack || htfStackComplete(input.htf);
  // Incomplete stack → no directional HTF bias for promote (m1 alone must not invent TREND)
  const bias = stackOk ? capitalHtfBias(input.htf) : 'FLAT';
  const m1 = input.htf?.m1;
  const blockHtfOnChop = g.playbook_block_htf_promote_on_live_chop !== false;
  const blockStoryOnChop = g.playbook_block_story_promote_on_live_chop !== false;
  const chopOverridesTrend = g.playbook_chop_overrides_sticky_trend !== false;

  // 1) Live structural owners
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

  // 2) Sticky TREND demote → SIDE when proven chop + no clean HTF direction
  if (
    chopOverridesTrend &&
    TRENDISH.has(live) &&
    (ch === 'RANGE_CHOP' || ch === 'MIXED') &&
    (bias === 'FLAT' || bias === 'MIXED' || !stackOk)
  ) {
    return rangeFade(
      'RANGE',
      'RANGE smadzenes · sticky TREND→SIDE (chop stāsts · HTF nav tīrs)'
    );
  }

  // 3) Live TREND/PULLBACK (when not demoted) — before story BREAK (resume owns)
  if (TRENDISH.has(live)) {
    return { lane: 'TREND_PULLBACK', regime: live, why_lv: `TREND smadzenes · live ${live}` };
  }

  // 4) Break story on chop/unknown — pierce owns (before side / HTF)
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

  // 5) SIDE first on live chop — before HTF / story TREND promote
  if (CHOP.has(live)) {
    if (
      (bias === 'FLAT' || bias === 'MIXED') &&
      (ch === 'EXHAUST_HI' || ch === 'EXHAUST_LO')
    ) {
      return rangeFade(live, `RANGE · ${ch} tip · gaida reject (ne fade knife / ne fake TREND)`);
    }
    if (isSideStory(ch, allow) || blockHtfOnChop || blockStoryOnChop) {
      // Explicit side chapters always RANGE_FADE on live chop
      if (
        ch === 'RANGE_CHOP' ||
        ch === 'MIXED' ||
        ch === 'SEEDING' ||
        !ch ||
        allow === 'NONE' ||
        allow === 'BOTH' ||
        ch === 'EXHAUST_HI' ||
        ch === 'EXHAUST_LO'
      ) {
        return rangeFade(
          live,
          stackOk && (bias === 'FLAT' || bias === 'MIXED')
            ? 'RANGE smadzenes · HTF flat/mixed + chop stāsts'
            : 'RANGE smadzenes · live chop · SIDE pirms HTF/stāsta promote'
        );
      }
      // RALLY/SELLOFF/EXHAUST on live chop: stay SIDE when story promote blocked
      // (not DIP_IN_RALLY / BOUNCE_IN_SELL — those keep pullback handlers below)
      if (
        blockStoryOnChop &&
        (ch === 'RALLY' ||
          ch === 'SELLOFF' ||
          ch === 'EXHAUST_HI' ||
          ch === 'EXHAUST_LO' ||
          ((allow === 'BUY' || allow === 'SELL') &&
            ch !== 'DIP_IN_RALLY' &&
            ch !== 'BOUNCE_IN_SELL'))
      ) {
        return rangeFade(
          live,
          'RANGE smadzenes · live chop · stāsts nepromotē TREND'
        );
      }
    }
    // HTF promote off live chop only when explicitly allowed + full stack + clear bias
    if (!blockHtfOnChop && stackOk && bias === 'UP') {
      const regime: RegimeName =
        ch === 'DIP_IN_RALLY' || m1 === 'DOWN' ? 'PULLBACK_UPTREND' : 'TREND_UP';
      return {
        lane: 'TREND_PULLBACK',
        regime,
        why_lv: `TREND smadzenes · Capital HTF UP → ${regime}`,
      };
    }
    if (!blockHtfOnChop && stackOk && bias === 'DOWN') {
      const regime: RegimeName =
        ch === 'BOUNCE_IN_SELL' || m1 === 'UP' ? 'PULLBACK_DOWNTREND' : 'TREND_DOWN';
      return {
        lane: 'TREND_PULLBACK',
        regime,
        why_lv: `TREND smadzenes · Capital HTF DOWN → ${regime}`,
      };
    }
    if (!blockStoryOnChop) {
      const unifyPromote = g.playbook_promote_vs_live_unify !== false;
      if (unifyPromote) {
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
      }
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
    return rangeFade(live, 'RANGE smadzenes · live chop · nav skaidra HTF/stāsta');
  }

  // 6) Non-chop live (UNKNOWN etc.): HTF / story with full-stack gate
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
  if (stackOk && bias === 'UP') {
    const regime: RegimeName =
      ch === 'DIP_IN_RALLY' || m1 === 'DOWN' ? 'PULLBACK_UPTREND' : 'TREND_UP';
    return {
      lane: 'TREND_PULLBACK',
      regime,
      why_lv: `TREND smadzenes · Capital HTF UP → ${regime}`,
    };
  }
  if (stackOk && bias === 'DOWN') {
    const regime: RegimeName =
      ch === 'BOUNCE_IN_SELL' || m1 === 'UP' ? 'PULLBACK_DOWNTREND' : 'TREND_DOWN';
    return {
      lane: 'TREND_PULLBACK',
      regime,
      why_lv: `TREND smadzenes · Capital HTF DOWN → ${regime}`,
    };
  }
  const unifyPromote = g.playbook_promote_vs_live_unify !== false;
  if (unifyPromote) {
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
  }

  if (live === 'UNKNOWN') {
    return {
      lane: 'LIVE',
      regime: 'UNKNOWN',
      why_lv: 'WAIT · nav skaidra HTF/stāsta · ne RANGE fade',
    };
  }
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
