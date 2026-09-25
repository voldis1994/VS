import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import {
  BRAIN_RELOAD_EXIT_CODE,
  LIVE_LOOP_ENV,
  brainReloadFlagPath,
  clearBrainReloadRequest,
  clearStaleBrainReloadOnBoot,
  hasBrainReloadRequest,
  maybeExitForBrainCodeReload,
  requestBrainCodeReload,
} from './brainReload.js';

describe('brainReload — soft restart when FLAT', () => {
  const prev = process.env[LIVE_LOOP_ENV];

  beforeEach(() => {
    delete process.env[LIVE_LOOP_ENV];
    clearBrainReloadRequest();
  });

  afterEach(() => {
    clearBrainReloadRequest();
    if (prev === undefined) delete process.env[LIVE_LOOP_ENV];
    else process.env[LIVE_LOOP_ENV] = prev;
  });

  it('writes and clears reload flag', () => {
    expect(hasBrainReloadRequest()).toBe(false);
    requestBrainCodeReload({
      cycle_id: 'cycle_test',
      reason: 'unit',
      files: ['apps/control-api/src/services/flipFilter.ts'],
    });
    expect(hasBrainReloadRequest()).toBe(true);
    const raw = JSON.parse(fs.readFileSync(brainReloadFlagPath(), 'utf8')) as {
      cycle_id: string;
    };
    expect(raw.cycle_id).toBe('cycle_test');
    clearBrainReloadRequest();
    expect(hasBrainReloadRequest()).toBe(false);
  });

  it('does not exit while any trade is open (even in live-loop)', () => {
    process.env[LIVE_LOOP_ENV] = '1';
    requestBrainCodeReload({ cycle_id: 'open', reason: 'unit' });
    const exitSpy = viExit();
    maybeExitForBrainCodeReload({ anyOpenTrade: true });
    expect(exitSpy.called).toBe(false);
    expect(hasBrainReloadRequest()).toBe(true);
    exitSpy.restore();
  });

  it('does NOT exit without live-loop — keeps API alive (Failed to fetch fix)', () => {
    delete process.env[LIVE_LOOP_ENV];
    requestBrainCodeReload({ cycle_id: 'bare', reason: 'unit' });
    const exitSpy = viExit();
    maybeExitForBrainCodeReload({ anyOpenTrade: false });
    expect(exitSpy.called).toBe(false);
    expect(hasBrainReloadRequest()).toBe(true);
    exitSpy.restore();
  });

  it('clears stale reload flag on boot when not in live-loop', () => {
    requestBrainCodeReload({ cycle_id: 'stale', reason: 'unit' });
    clearStaleBrainReloadOnBoot();
    expect(hasBrainReloadRequest()).toBe(false);
  });

  it('schedules exit 75 when FLAT under live-loop', async () => {
    process.env[LIVE_LOOP_ENV] = '1';
    requestBrainCodeReload({ cycle_id: 'flat', reason: 'unit' });
    const exitSpy = viExit();
    maybeExitForBrainCodeReload({ anyOpenTrade: false });
    expect(hasBrainReloadRequest()).toBe(false);
    await new Promise((r) => setTimeout(r, 200));
    expect(exitSpy.code).toBe(BRAIN_RELOAD_EXIT_CODE);
    exitSpy.restore();
  });
});

function viExit(): { called: boolean; code: number | null; restore: () => void } {
  const state = { called: false, code: null as number | null };
  const orig = process.exit;
  // @ts-expect-error test stub
  process.exit = ((code?: number) => {
    state.called = true;
    state.code = code ?? 0;
  }) as typeof process.exit;
  return {
    get called() {
      return state.called;
    },
    get code() {
      return state.code;
    },
    restore: () => {
      process.exit = orig;
    },
  };
}
