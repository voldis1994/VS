/**
 * Unified desk harden contract — what the live system must keep true.
 * Ported from audited good open-PR ideas (#639 Soft tighten; #694 honesty;
 * #665 late-chop; #690 float dust) without reverting HTF Engine v2.
 */
import { describe, expect, it } from 'vitest';
import {
  proposeAutoCalibration,
  AUTO_CAL_MIN_HARDINV_ABS,
} from './autoCalibrate.js';
import { defaultDeskCalibration, setDeskCalibration } from './deskCalibration.js';
import { classifyRegime, type TenSecBar } from './regimes.js';
import { reviewSessionLikeHuman } from './traderMind.js';

function trade(partial: {
  pnl_pts: number;
  exit_reason?: string;
  mfe?: number;
  mae?: number;
}) {
  return {
    pnl_pts: partial.pnl_pts,
    exit_reason: partial.exit_reason ?? 'Target',
    mfe: partial.mfe ?? Math.max(0, partial.pnl_pts),
    mae: partial.mae ?? Math.min(0, partial.pnl_pts),
    regime: 'TREND_UP',
    closed_at: Date.now(),
  };
}

function bar(o: number, h: number, l: number, c: number, i: number): TenSecBar {
  return {
    open: o,
    high: h,
    low: l,
    close: c,
    open_time_ms: 1_700_000_000_000 + i * 10_000,
  };
}

describe('desk harden contract', () => {
  it('Soft-heavy auto-cal tightens Soft CAP (from #639) — no forever factory hold', () => {
    const base = defaultDeskCalibration();
    const r = proposeAutoCalibration(base, [
      trade({ pnl_pts: -2.0, exit_reason: 'HardInvalidation' }),
      trade({ pnl_pts: -1.8, exit_reason: 'HardInvalidation' }),
      trade({ pnl_pts: -0.5 }),
      trade({ pnl_pts: 0.3, exit_reason: 'PeakProtection', mfe: 0.4 }),
      trade({ pnl_pts: -1.5, exit_reason: 'HardInvalidation' }),
    ]);
    expect(r.applied).toBe(true);
    expect(r.next.hardinv_abs).toBeLessThan(base.hardinv_abs);
    expect(r.next.hardinv_abs).toBeGreaterThanOrEqual(AUTO_CAL_MIN_HARDINV_ABS);
    expect(r.changes.some((c) => c.includes('Soft tighten'))).toBe(true);
    // Never kill regimes (main policy — not #639 demote)
    expect(r.next.enabled_regimes.length).toBeGreaterThanOrEqual(base.enabled_regimes.length);
  });

  it('never claims pieeja strādā when Soft still in window (from #694)', () => {
    const lesson = reviewSessionLikeHuman([
      { pnl_pts: 3.5, exit_reason: 'PeakProtection', mfe: 4, mae: 0.2 },
      { pnl_pts: 2.8, exit_reason: 'Target', mfe: 3, mae: 0.1 },
      { pnl_pts: -2.2, exit_reason: 'HardInvalidation', mfe: 0.3, mae: 2.2 },
      { pnl_pts: 1.5, exit_reason: 'PeakProtection', mfe: 2, mae: 0.2 },
      { pnl_pts: 1.2, exit_reason: 'MindBank', mfe: 1.5, mae: 0.1 },
    ]);
    expect(lesson.diagnosis).not.toMatch(/pieeja strādā/i);
    expect(lesson.diagnosis).toMatch(/Soft|NAV dienas peļņa/i);
  });

  it('dump then side box → RANGE not fake TREND_UP (from #665)', () => {
    const bars: TenSecBar[] = [];
    const n = 220;
    for (let i = 0; i < n; i++) {
      const z = i - (n - 180);
      let c: number;
      if (z < 0) c = 4192;
      else if (z < 60) c = 4192 - (z / 59) * 40;
      else if (z < 120) c = 4152.5 + ((z % 5) - 2) * 0.35;
      else {
        const t = z - 120;
        c =
          t < 10
            ? 4152.5 + (t / 9) * 12
            : 4164 + Math.sin((t - 10) / 1.8) * 8 + ((t % 5) - 2) * 0.55;
      }
      const o = c + ((i % 3) - 1) * 0.06;
      bars.push(bar(o, Math.max(o, c) + 0.3, Math.min(o, c) - 0.25, c, i));
    }
    const tip = bars[bars.length - 1]!.close;
    bars.push(bar(tip, tip + 0.2, tip - 0.25, tip + 0.04, n));
    expect(classifyRegime(bars, 'UNKNOWN')).toBe('RANGE');
    expect(classifyRegime(bars, 'TREND_UP')).toBe('RANGE');
  });

  it('desk knobs round float dust (from #690 / #691)', () => {
    const c = setDeskCalibration({
      peak_mfe_abs: 4.3999999999999995,
      safety_tp_rr: 1.7999999999999998,
      target_abs: 6.75,
    });
    expect(c.peak_mfe_abs).toBe(4.4);
    expect(c.safety_tp_rr).toBe(1.8);
    expect(String(c.peak_mfe_abs)).not.toMatch(/99999/);
  });
});
