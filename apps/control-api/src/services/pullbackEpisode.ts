/**
 * Pullback episode — manage-side detect of adverse bounce/dip against a
 * TREND thesis. Missing puzzle: Soft HardInv ate TREND_DOWN SELL after a
 * small green MFE because Peak never armed (Soft×1.35) while the V-bounce
 * started. This module marks episode start/end so Peak Soft× can drop and
 * Soft+ can bank before Soft eats the win. Genome-calibrated.
 */
import type { RegimeName } from './regimes.js';
import { getBrainGenome } from '../brainSelfImprove/brainGenome.js';

export type PullbackEpisodeMinutePolicy = 'continue' | 'reverse' | 'wait';

/** Factory residual sets (= prior hardcode) */
export const TREND_THESIS = [
  'TREND_UP',
  'TREND_DOWN',
  'PULLBACK_UPTREND',
  'PULLBACK_DOWNTREND',
] as const;

export const ADVERSE_CHAPTERS_SELL = [
  'BOUNCE_IN_SELL',
  'EXHAUST_LO',
  'RALLY',
  'BREAK_UP',
] as const;

export const ADVERSE_CHAPTERS_BUY = [
  'DIP_IN_RALLY',
  'EXHAUST_HI',
  'SELLOFF',
  'BREAK_DOWN',
] as const;

export const RESUME_CHAPTERS_SELL = ['SELLOFF', 'BREAK_DOWN'] as const;
export const RESUME_CHAPTERS_BUY = ['RALLY', 'BREAK_UP'] as const;

export const SOFTPLUS_PULLBACK_STORY_EXEC_MULT = 0.95;

function chapterSet(list: string[] | readonly string[] | undefined, fallback: readonly string[]): Set<string> {
  const src = list?.length ? list : fallback;
  return new Set(src.map((x) => String(x).toUpperCase()));
}

export function isTrendFamilyThesis(regime?: string | null): boolean {
  const g = getBrainGenome();
  const set = chapterSet(g.trend_thesis_regimes, TREND_THESIS);
  const r = String(regime || '')
    .trim()
    .toUpperCase();
  return set.has(r);
}

/** Adverse chapter vs open side — bounce against SELL / dip against BUY. */
export function adversePullbackChapter(
  openSide: 'BUY' | 'SELL',
  chapter?: string | null
): boolean {
  const g = getBrainGenome();
  const ch = String(chapter || '')
    .trim()
    .toUpperCase();
  if (openSide === 'SELL') {
    return chapterSet(g.adverse_chapters_sell, ADVERSE_CHAPTERS_SELL).has(ch);
  }
  return chapterSet(g.adverse_chapters_buy, ADVERSE_CHAPTERS_BUY).has(ch);
}

/** Resume chapter with open side — selloff continues / rally continues. */
export function resumeTrendChapter(
  openSide: 'BUY' | 'SELL',
  chapter?: string | null
): boolean {
  const g = getBrainGenome();
  const ch = String(chapter || '')
    .trim()
    .toUpperCase();
  if (openSide === 'SELL') {
    return chapterSet(g.resume_chapters_sell, RESUME_CHAPTERS_SELL).has(ch);
  }
  return chapterSet(g.resume_chapters_buy, RESUME_CHAPTERS_BUY).has(ch);
}

/** Live regime flipped against open TREND side. */
export function liveRegimeAgainstSide(
  openSide: 'BUY' | 'SELL',
  liveRegime?: string | null
): boolean {
  const r = String(liveRegime || '')
    .trim()
    .toUpperCase() as RegimeName | string;
  if (openSide === 'SELL') {
    return (
      r === 'TREND_UP' ||
      r === 'PULLBACK_UPTREND' ||
      r === 'BREAKOUT_UP' ||
      r === 'FAILED_BREAKOUT_DOWN'
    );
  }
  return (
    r === 'TREND_DOWN' ||
    r === 'PULLBACK_DOWNTREND' ||
    r === 'BREAKOUT_DOWN' ||
    r === 'FAILED_BREAKOUT_UP'
  );
}

export function liveRegimeWithSide(
  openSide: 'BUY' | 'SELL',
  liveRegime?: string | null
): boolean {
  const r = String(liveRegime || '')
    .trim()
    .toUpperCase();
  if (openSide === 'SELL') {
    return r === 'TREND_DOWN' || r === 'PULLBACK_DOWNTREND' || r === 'BREAKOUT_DOWN';
  }
  return r === 'TREND_UP' || r === 'PULLBACK_UPTREND' || r === 'BREAKOUT_UP';
}

export type PullbackEpisodeDetectInput = {
  enabled: boolean;
  openSide: 'BUY' | 'SELL';
  entryRegime?: string | null;
  liveRegime?: string | null;
  storyChapter?: string | null;
  minutePolicy: PullbackEpisodeMinutePolicy;
  /** Already inside an active episode */
  active: boolean;
};

/**
 * Start: TREND thesis + adverse bounce/dip (chapter / 1m reverse / live flip).
 * End: 1m continue with side, or resume chapter, or live regime back with side.
 */
export function detectPullbackEpisode(input: PullbackEpisodeDetectInput): {
  active: boolean;
  started: boolean;
  ended: boolean;
  why: string;
} {
  const g = getBrainGenome();
  const enabled = input.enabled && g.pullback_episode_enabled !== false;
  if (!enabled || !isTrendFamilyThesis(input.entryRegime)) {
    return {
      active: false,
      started: false,
      ended: input.active,
      why: !enabled ? 'episode OFF' : 'ne TREND thesis',
    };
  }

  const adverseCh = adversePullbackChapter(input.openSide, input.storyChapter);
  const againstLive = liveRegimeAgainstSide(input.openSide, input.liveRegime);
  const reverse1m = input.minutePolicy === 'reverse';
  const wantStart = adverseCh || againstLive || reverse1m;

  if (!input.active) {
    if (!wantStart) {
      return { active: false, started: false, ended: false, why: 'gaida adverse pullback' };
    }
    const bits: string[] = [];
    if (adverseCh) bits.push(`ch ${String(input.storyChapter)}`);
    if (againstLive) bits.push(`live ${String(input.liveRegime)}`);
    if (reverse1m) bits.push('1m reverse');
    return {
      active: true,
      started: true,
      ended: false,
      why: `START · ${bits.join(' · ')}`,
    };
  }

  // Active — check end (resume with trend)
  const resumeCh = resumeTrendChapter(input.openSide, input.storyChapter);
  const withLive = liveRegimeWithSide(input.openSide, input.liveRegime);
  const continue1m = input.minutePolicy === 'continue';
  const endOnContinue = g.episode_end_on_continue !== false;
  // End only on clear resume — not on wait/doji while still adverse
  const wantEnd =
    (endOnContinue && continue1m && (resumeCh || withLive || !adverseCh)) ||
    (resumeCh && withLive) ||
    (endOnContinue && continue1m && !adverseCh && !againstLive);

  if (wantEnd) {
    const bits: string[] = [];
    if (continue1m) bits.push('1m continue');
    if (resumeCh) bits.push(`ch ${String(input.storyChapter)}`);
    if (withLive) bits.push(`live ${String(input.liveRegime)}`);
    return {
      active: false,
      started: false,
      ended: true,
      why: `END resume · ${bits.join(' · ') || 'clear'}`,
    };
  }

  return {
    active: true,
    started: false,
    ended: false,
    why: `ACTIVE · ${adverseCh ? String(input.storyChapter) : againstLive ? String(input.liveRegime) : 'hold'}`,
  };
}

/**
 * Soft+ still green but pullback episode active — bank Soft×1 before Soft eats.
 * Same spirit as story-fight Soft+ bank; episode is the structured detect.
 */
export function softPlusPullbackEpisodeShouldBank(opts: {
  episodeActive: boolean;
  mfe: number;
  softSl: number;
  execFav: number;
  retention: number;
  keep: number;
  /** Genome: min MFE as Soft× before Soft+ bank in episode (factory 0.5) */
  minMfeSoftMult: number;
}): boolean {
  if (!opts.episodeActive) return false;
  const soft = Math.max(opts.softSl, 1e-9);
  const g = getBrainGenome();
  const need = soft * Math.max(0.25, opts.minMfeSoftMult);
  if (!(opts.mfe >= need)) return false;
  const execMult =
    g.softplus_pullback_story_exec_mult ||
    g.episode_softplus_bank_mult ||
    SOFTPLUS_PULLBACK_STORY_EXEC_MULT;
  // Bank while still Soft-green (or nearly Soft) — not micro pennies
  if (!(opts.execFav >= soft * execMult)) return false;
  return opts.retention < opts.keep;
}
