import { describe, expect, it } from 'vitest';
import type { CapitalPriceCandle } from './capitalCom.js';
import {
  emptySetup,
  recentImpulse,
  recentLocalRange,
  updateSetupSticky,
  type StructureBook,
} from './marketSetup.js';

function candle(o: number, h: number, l: number, c: number): CapitalPriceCandle {
  return { open: o, high: h, low: l, close: c };
}

/**
 * Gold 07:55 class: sticky overnight swing H4440/L4417, price mid ~4422
 * dumping from local 4428 peak — was eternal NONE · mid swing.
 * Overnight extremes age out of the local 12–15m window.
 */
function midSwingDumpBars(): CapitalPriceCandle[] {
  const bars: CapitalPriceCandle[] = [];
  for (let i = 0; i < 10; i++) bars.push(candle(4435, 4438, 4433, 4436));
  bars.push(candle(4436, 4440.08, 4434, 4438)); // sticky high print
  bars.push(candle(4438, 4439, 4425, 4426));
  bars.push(candle(4426, 4427, 4417.14, 4419)); // sticky low print
  // Age overnight extremes out of local window
  for (let i = 0; i < 8; i++) {
    bars.push(candle(4420 + i * 0.5, 4421 + i * 0.5, 4419 + i * 0.5, 4420.5 + i * 0.5));
  }
  // Local bounce then dump 4428 → 4422
  bars.push(candle(4424, 4426, 4423, 4425));
  bars.push(candle(4425, 4428.5, 4424, 4427.8));
  bars.push(candle(4427.8, 4428.2, 4425, 4425.5));
  bars.push(candle(4425.5, 4426, 4423.5, 4424));
  bars.push(candle(4424, 4424.5, 4422.5, 4423));
  bars.push(candle(4423, 4423.5, 4421.8, 4422.3));
  bars.push(candle(4422.3, 4422.8, 4421.5, 4422.0));
  return bars;
}

describe('mid-swing impulse — sticky wide H/L must not freeze NONE', () => {
  it('recentLocalRange ignores overnight sticky extremes', () => {
    const bars = midSwingDumpBars();
    const local = recentLocalRange(bars, 12);
    expect(local.hi).toBeLessThan(4435);
    expect(local.lo).toBeGreaterThan(4416);
    expect(local.span).toBeLessThan(20);
  });

  it('DOWN impulse still fires on local dump mid wide swing', () => {
    const bars = midSwingDumpBars();
    const imp = recentImpulse(bars, 'flip') || recentImpulse(bars);
    expect(imp).toBe('DOWN');
  });

  it('arms CONTINUATION SELL at ~4422 with sticky H4440/L4417 (not NONE mid swing)', () => {
    const bars = midSwingDumpBars();
    const last = bars[bars.length - 1]!;
    const sticky: StructureBook = {
      ready: true,
      swing_high: 4440.08,
      swing_low: 4417.14,
      mid: (4440.08 + 4417.14) / 2,
      span: 4440.08 - 4417.14,
      bias: 'BELOW',
      near_high: false,
      near_low: false,
      at_tip: false,
      at_floor: false,
      hour_bias: 'DOWN',
      bar_count: bars.length,
      detail: 'sticky overnight',
      updated_at: new Date().toISOString(),
    };
    expect(last.close).toBeLessThan(sticky.mid);
    expect(sticky.at_floor).toBe(false);

    let setup = emptySetup();
    setup = updateSetupSticky(setup, sticky, bars);
    setup = updateSetupSticky(setup, sticky, bars);

    expect(setup.kind).toBe('CONTINUATION');
    expect(setup.side).toBe('SELL');
    expect(setup.status).toBe('ARMED');
    expect(setup.reason).not.toMatch(/NONE · mid swing/);
  });
});
