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
  it('pins MAIN identity, 0.15% SL, and BE-only manage', () => {
    expect(DESK_PROTOTYPE).toBe('MAIN');
    expect(SAFETY_SL_REL).toBe(0.0015);
    expect(DESK_PROTOTYPE_SL).toBe('0.15%-of-price');
    const info = runtimeBuildInfo();
    expect(info.desk_prototype).toBe('MAIN');
    expect(info.sl).toBe('0.15%-of-price');
    expect(info.entry_brain).toBe('node-robot-desk');
    expect(info.STRATEGY_VERSION).toBe('main-prototype-10s-sl015-be');
    expect(deskPrototypeRules()).toMatch(/MAIN PROTOTYPE/);
    expect(deskPrototypeRules()).toMatch(/SL→BE/);
  });

  it('screenshot dump: PULLBACK_UPTREND + DOWN is SELL, never SCAN', () => {
    const e = resolveDeskEntry({
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

  it('Best Outcome never closes — plus trails SL to BE only after 0.15%', () => {
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
    expect(plus.action).toBe('TRAIL');
    expect(plus.trail_stop).toBe(4360);

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
    expect(noise.action).toBe('TRAIL');
    expect(noise.trail_stop).toBe(4360);

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
    expect(desk).toContain('resolveDeskEntry');
    expect(desk).toContain('releaseGhostIntents');
    expect(desk).toContain('await enterTrade(');
    expect(desk).toContain('MAIN PROTOTYPE');
    expect(desk).toContain('this 10s already filled');
    expect(desk).not.toContain('evaluateStrategy({');

    const start = readFileSync(join(repoRoot, 'START_MSI.bat'), 'utf8');
    expect(start).toContain('git fetch origin main');
    expect(start).toContain('git pull origin main');
    expect(start).not.toMatch(/git pull origin main 2>nul/);

    const palaid = readFileSync(join(repoRoot, 'PALAID.bat'), 'utf8');
    expect(palaid).toContain('START_MSI.bat');

    const ui = readFileSync(join(repoRoot, 'ADMIN/desk/src/pages/RobotDeskPage.tsx'), 'utf8');
    expect(ui).not.toContain('no fade');
  });
});
