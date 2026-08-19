import { describe, expect, it } from 'vitest';
import { runtimeBuildInfo } from './runtimeBuild.js';

describe('runtimeBuildInfo', () => {
  it('reports Node robotDesk as the entry brain and 0.25% of price SL', () => {
    const info = runtimeBuildInfo();
    expect(info.entry_brain).toBe('node-robot-desk');
    expect(info.sl).toBe('0.25%-of-price');
    expect(info.trend_minutes).toBe(3);
    expect(info.unknown_bias_unlock).toBe(true);
    expect(info.git_sha).toMatch(/^[0-9a-f]{7,40}$|^unknown$/);
    expect(info.VERSION).toBeTruthy();
    expect(info.GIT_COMMIT).toBe(info.git_sha);
    expect(info.BUILD_TIME).toBeTruthy();
    expect(info.STRATEGY_VERSION).toBeTruthy();
    expect(info.historical_strategy).toBe('NOT_PROVEN');
  });
});
