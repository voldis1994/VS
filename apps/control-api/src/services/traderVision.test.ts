import { describe, expect, it } from 'vitest';
import { buildTraderView, traderEntryGate } from './traderVision.js';
import { decideEntryFrom10sRegime } from './entryFromRegime.js';
import type { TenSecBar } from './tenSecondOhlc.js';

function bar(
  open: number,
  close: number,
  i: number,
  w = 0.4
): TenSecBar {
  return {
    open_time_ms: i * 10_000,
    open,
    high: Math.max(open, close) + w,
    low: Math.min(open, close) - w,
    close,
    ticks: 8,
  };
}

/** Spike 4591 → 4597 then at top — like user screenshot. */
function spikeTopScenario(): { bars: TenSecBar[]; top: TenSecBar } {
  const bars: TenSecBar[] = [];
  let px = 4591;
  for (let i = 0; i < 24; i++) {
    const step = 0.08;
    bars.push(bar(px, px + step, i, 0.2));
    px += step;
  }
  for (let i = 24; i < 28; i++) {
    const step = 0.35;
    bars.push(bar(px, px + step, i, 0.15));
    px += step;
  }
  const top = bar(4596.4, 4596.9, 28, 0.1);
  return { bars, top };
}

/** Early uptrend + pullback bounce — trader dip-buy. */
function dipBuyScenario(): { bars: TenSecBar[]; live: TenSecBar } {
  const bars: TenSecBar[] = [];
  let px = 4588;
  for (let i = 0; i < 22; i++) {
    const o = px;
    const c = px + 0.1;
    bars.push(bar(o, c, i, 0.2));
    px = c;
  }
  for (let i = 22; i < 28; i++) {
    const o = px;
    const c = px - 0.12;
    bars.push(bar(o, c, i, 0.2));
    px = c;
  }
  const live = bar(px, px + 0.15, 28, 0.15);
  return { bars, live };
}

describe('traderVision', () => {
  it('sees price at swing HIGH after spike', () => {
    const { bars, top } = spikeTopScenario();
    const view = buildTraderView(bars, top)!;
    expect(view.rangePos).toBeGreaterThan(0.8);
    expect(view.pts5m).toBeGreaterThan(2);
    expect(view.location).toMatch(/SWING_HIGH|UPPER/);
    expect(view.narrative).toMatch(/TRADER/);
  });

  it('blocks BUY chase at spike top (user screenshot case)', () => {
    const { bars, top } = spikeTopScenario();
    const view = buildTraderView(bars, top)!;
    const gate = traderEntryGate('BUY', view, top);
    expect(gate.ok).toBe(false);
    expect(gate.reason).toMatch(/NO BUY|chase top|climax/i);
  });

  it('decideEntryFrom10sRegime returns null at spike top (no 5m + trader blocks EARLY)', () => {
    const { bars, top } = spikeTopScenario();
    const withProv = bars.map((b) => ({ ...b, provenance: 'REAL' as const }));
    const topBar = { ...top, provenance: 'REAL' as const };
    expect(
      decideEntryFrom10sRegime(topBar, 'TRANSITION', withProv, {
        multiTfReady: true,
        analysis_price: top.close,
      })
    ).toBeNull();
  });

  it('allows entry on dip via traderEntryGate (EARLY path uses this gate)', () => {
    const { bars, live } = dipBuyScenario();
    const view = buildTraderView(bars, live)!;
    const gate = traderEntryGate('BUY', view, live);
    expect(gate.ok).toBe(true);
    expect(gate.reason).toMatch(/OK BUY/);
  });
});
