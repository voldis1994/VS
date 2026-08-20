import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDeskEntry } from './deskEntry.js';
import { decideBestOutcomeExit } from './exitManage.js';
import { SAFETY_SL_REL } from './capitalCom.js';
import { DESK_PROTOTYPE, DESK_PROTOTYPE_SL, deskPrototypeRules } from './mainPrototype.js';
import { runtimeBuildInfo } from './runtimeBuild.js';
import type { TenSecBar } from './tenSecondOhlc.js';
import type { PriceRef } from './staleQuoteGuard.js';

function bar(open: number, close: number): TenSecBar {
  return {
    open_time_ms: 0,
    open,
    high: Math.max(open, close) + 0.4,
    low: Math.min(open, close) - 0.4,
    close,
    ticks: 12,
  };
}

function cluster(mid: number): PriceRef[] {
  return [
    { label: 'Gold-API spot (public)', mid: mid - 0.2 },
    { label: 'Coinbase spot (public)', mid: mid + 0.1 },
    { label: 'Kraken spot (public)', mid: mid },
  ];
}

const repoRoot = join(process.cwd(), '..', '..');

describe('MAIN prototype freeze', () => {
  it('pins MAIN identity, ~0.13% entry SL (3× tighter), and exit-only manage', () => {
    expect(DESK_PROTOTYPE).toBe('MAIN');
    expect(SAFETY_SL_REL).toBeCloseTo(0.004 / 3, 10);
    expect(DESK_PROTOTYPE_SL).toBe('0.13%-of-price');
    const info = runtimeBuildInfo();
    expect(info.desk_prototype).toBe('MAIN');
    expect(info.sl).toBe('0.13%-of-price');
    expect(info.entry_brain).toBe('cpp-super-entry');
    expect(info.STRATEGY_VERSION).toBe('main-prototype-10s-sl013-exit');
    expect(deskPrototypeRules()).toMatch(/MAIN PROTOTYPE/);
    expect(deskPrototypeRules()).toMatch(/Exit Best Outcome close only/);
    expect(deskPrototypeRules()).toMatch(/SUPER C\+\+ entry/);
  });

  it('screenshot dump: PULLBACK_UPTREND + DOWN needs structure + supply zone', () => {
    const lone = resolveDeskEntry({
      bar: {
        open_time_ms: 0,
        open: 4354.67,
        high: 4354.67,
        low: 4354.13,
        close: 4354.13,
        ticks: 8,
      },
      regime: 'PULLBACK_UPTREND',
      bias: 'DOWN',
      capitalMid: 4356.46,
      refs: cluster(4354.13),
    });
    expect(lone.direction).toBeNull();

    // Dump → supply swing → red reject (same shape as deskEntry dumpSupplyTouch).
    const bars: TenSecBar[] = [
      { open_time_ms: 0, open: 4380, high: 4382, low: 4378, close: 4379, ticks: 10 },
      { open_time_ms: 1, open: 4379, high: 4380, low: 4375, close: 4376, ticks: 10 },
      { open_time_ms: 2, open: 4376, high: 4377, low: 4372, close: 4373, ticks: 10 },
      { open_time_ms: 3, open: 4373, high: 4374, low: 4369, close: 4370, ticks: 10 },
      { open_time_ms: 4, open: 4370, high: 4371, low: 4366, close: 4367, ticks: 10 },
      { open_time_ms: 5, open: 4367, high: 4375, low: 4366, close: 4374, ticks: 10 },
      { open_time_ms: 6, open: 4374, high: 4374.5, low: 4371, close: 4372, ticks: 10 },
      { open_time_ms: 7, open: 4372, high: 4375.2, low: 4369, close: 4370, ticks: 10 },
    ];
    const last = bars[bars.length - 1]!;
    const e = resolveDeskEntry({
      bar: last,
      closedBars: bars,
      regime: 'PULLBACK_UPTREND',
      bias: 'DOWN',
      capitalMid: last.close,
      refs: cluster(last.close),
    });
    expect(e.direction).toBe('SELL');
  });

  it('RANGE + bias UP + closed 10s does not force a side', () => {
    const e = resolveDeskEntry({
      bar: bar(4360.8, 4360.9),
      regime: 'RANGE',
      bias: 'UP',
      capitalMid: 4360.7,
      refs: cluster(4360.7),
    });
    expect(e.direction).toBeNull();
  });

  it('Best Outcome holds in plus — exit closes only on rules, never trails SL', () => {
    const plus = decideBestOutcomeExit(
      {
        open_side: 'BUY',
        entry_price: 4360,
        entry_at: new Date().toISOString(),
        mfe: 12,
        mae: 0,
        peak_retention: 0.4,
        regime: 'RANGE',
        entry_setup: 'PULLBACK',
      },
      4372
    );
    expect(plus.exit).toBe(false);
    expect(plus.action).toBe('HOLD');

    const noise = decideBestOutcomeExit(
      {
        open_side: 'BUY',
        entry_price: 4360,
        entry_at: new Date().toISOString(),
        mfe: 4,
        mae: 0,
        peak_retention: 0.4,
        regime: 'RANGE',
        entry_setup: 'PULLBACK',
      },
      4365
    );
    expect(noise.exit).toBe(false);
    expect(noise.action).toBe('HOLD');

    const minus = decideBestOutcomeExit(
      {
        open_side: 'BUY',
        entry_price: 4360,
        entry_at: new Date().toISOString(),
        mfe: 0,
        mae: -8,
        peak_retention: null,
        regime: 'RANGE',
        entry_setup: 'PULLBACK',
      },
      4350
    );
    expect(minus.exit).toBe(false);
    expect(minus.action).toBe('HOLD');
  });

  it('robotDesk + PALAID stay on origin/main prototype wiring', () => {
    const desk = readFileSync(join(process.cwd(), 'src/services/robotDesk.ts'), 'utf8');
    expect(desk).toContain('waiting confirms/C++');
    expect(desk).toContain('EXEC plan READY');
    expect(desk).toContain('entryPlanReady');
    expect(desk).toContain('regimeEntryPlan');
    expect(desk).toContain('releaseGhostIntents');
    expect(desk).toContain('await enterTrade(');
    expect(desk).toContain('MAIN PROTOTYPE');
    expect(desk).toContain('this 10s already filled');
    expect(desk).not.toContain('evaluateStrategy({');

    const start = readFileSync(join(repoRoot, 'START_MSI.bat'), 'utf8');
    expect(start).toContain('git fetch origin main');
    expect(start).toContain('git reset --hard origin/main');
    expect(start).not.toMatch(/git pull origin main 2>nul/);

    const palaid = readFileSync(join(repoRoot, 'PALAID.bat'), 'utf8');
    expect(palaid).toContain('START_MSI.bat');

    const ui = readFileSync(join(repoRoot, 'ADMIN/desk/src/pages/RobotDeskPage.tsx'), 'utf8');
    expect(ui).not.toContain('no fade');
  });
});
