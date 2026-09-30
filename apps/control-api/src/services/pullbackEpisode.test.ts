import { describe, expect, it } from 'vitest';
import {
  adversePullbackChapter,
  detectPullbackEpisode,
  softPlusPullbackEpisodeShouldBank,
} from './pullbackEpisode.js';
import { sanitizeGenome, _resetBrainGenomeForTests } from '../brainSelfImprove/brainGenome.js';

describe('pullbackEpisode detect', () => {
  it('starts on BOUNCE_IN_SELL against TREND_DOWN SELL', () => {
    const r = detectPullbackEpisode({
      enabled: true,
      openSide: 'SELL',
      entryRegime: 'TREND_DOWN',
      liveRegime: 'TREND_DOWN',
      storyChapter: 'BOUNCE_IN_SELL',
      minutePolicy: 'wait',
      active: false,
    });
    expect(r.started).toBe(true);
    expect(r.active).toBe(true);
    expect(r.why).toMatch(/START/);
  });

  it('starts on 1m reverse even without chapter', () => {
    const r = detectPullbackEpisode({
      enabled: true,
      openSide: 'SELL',
      entryRegime: 'TREND_DOWN',
      liveRegime: 'TREND_DOWN',
      storyChapter: 'SELLOFF',
      minutePolicy: 'reverse',
      active: false,
    });
    expect(r.started).toBe(true);
    expect(r.active).toBe(true);
  });

  it('ends on 1m continue + resume SELLOFF', () => {
    const r = detectPullbackEpisode({
      enabled: true,
      openSide: 'SELL',
      entryRegime: 'TREND_DOWN',
      liveRegime: 'TREND_DOWN',
      storyChapter: 'SELLOFF',
      minutePolicy: 'continue',
      active: true,
    });
    expect(r.ended).toBe(true);
    expect(r.active).toBe(false);
    expect(r.why).toMatch(/END resume/);
  });

  it('ignores non-TREND thesis', () => {
    const r = detectPullbackEpisode({
      enabled: true,
      openSide: 'SELL',
      entryRegime: 'RANGE',
      liveRegime: 'RANGE',
      storyChapter: 'BOUNCE_IN_SELL',
      minutePolicy: 'reverse',
      active: false,
    });
    expect(r.started).toBe(false);
    expect(r.active).toBe(false);
  });

  it('respects enabled=false', () => {
    const r = detectPullbackEpisode({
      enabled: false,
      openSide: 'SELL',
      entryRegime: 'TREND_DOWN',
      liveRegime: 'TREND_DOWN',
      storyChapter: 'BOUNCE_IN_SELL',
      minutePolicy: 'reverse',
      active: false,
    });
    expect(r.started).toBe(false);
    expect(r.active).toBe(false);
  });

  it('BUY starts on DIP_IN_RALLY', () => {
    expect(adversePullbackChapter('BUY', 'DIP_IN_RALLY')).toBe(true);
    const r = detectPullbackEpisode({
      enabled: true,
      openSide: 'BUY',
      entryRegime: 'TREND_UP',
      liveRegime: 'PULLBACK_DOWNTREND',
      storyChapter: 'DIP_IN_RALLY',
      minutePolicy: 'wait',
      active: false,
    });
    expect(r.started).toBe(true);
  });
});

describe('softPlusPullbackEpisodeShouldBank', () => {
  it('banks Soft+ green with giveback during episode', () => {
    expect(
      softPlusPullbackEpisodeShouldBank({
        episodeActive: true,
        mfe: 2.4,
        softSl: 2.2,
        execFav: 2.15,
        retention: 0.6,
        keep: 0.72,
        minMfeSoftMult: 0.5,
      })
    ).toBe(true);
  });

  it('skips when MFE below Soft× min', () => {
    expect(
      softPlusPullbackEpisodeShouldBank({
        episodeActive: true,
        mfe: 0.8,
        softSl: 2.2,
        execFav: 2.15,
        retention: 0.5,
        keep: 0.72,
        minMfeSoftMult: 0.5,
      })
    ).toBe(false);
  });

  it('skips when episode inactive', () => {
    expect(
      softPlusPullbackEpisodeShouldBank({
        episodeActive: false,
        mfe: 2.4,
        softSl: 2.2,
        execFav: 2.15,
        retention: 0.5,
        keep: 0.72,
        minMfeSoftMult: 0.5,
      })
    ).toBe(false);
  });
});

describe('genome pullback episode knobs', () => {
  it('defaults enabled Soft×1.0 / min Soft×0.5', () => {
    _resetBrainGenomeForTests({});
    const g = sanitizeGenome({});
    expect(g.pullback_episode_enabled).toBe(true);
    expect(g.pullback_episode_peak_arm_soft_mult).toBe(1.0);
    expect(g.pullback_episode_min_mfe_soft_mult).toBe(0.5);
  });

  it('clamps Soft× arm to 0.5…1.35', () => {
    const hi = sanitizeGenome({ pullback_episode_peak_arm_soft_mult: 9 });
    expect(hi.pullback_episode_peak_arm_soft_mult).toBe(1.35);
    const lo = sanitizeGenome({ pullback_episode_peak_arm_soft_mult: 0.1 });
    expect(lo.pullback_episode_peak_arm_soft_mult).toBe(0.5);
  });
});
