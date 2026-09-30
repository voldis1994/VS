import { describe, expect, it, beforeEach } from 'vitest';
import {
  activeSoftAbs,
  readSoftTargetLayers,
  suggestLayersFromExcursions,
  targetLayerHit,
  unlockedSoftLayer,
} from './profitLayers.js';
import {
  decideBestOutcomeExit,
  layeredHardInvDistance,
  hardInvStopDistance,
} from './exitManage.js';
import {
  defaultDeskCalibration,
  setDeskCalibration,
  _resetDeskCalibrationCacheForTests,
} from './deskCalibration.js';
import { _resetBrainGenomeForTests } from '../brainSelfImprove/brainGenome.js';

describe('Soft/Target 3-layer ladder', () => {
  beforeEach(() => {
    _resetDeskCalibrationCacheForTests();
    _resetBrainGenomeForTests({ soft_layer_unlock_mult: 1.0 });
    setDeskCalibration(defaultDeskCalibration());
  });

  it('desk defaults Soft 1.2/1.8/2.2 · Target 2.5/3.5/5.0', () => {
    const L = readSoftTargetLayers();
    expect(L.soft).toEqual([1.2, 1.8, 2.2]);
    expect(L.target).toEqual([2.5, 3.5, 5.0]);
  });

  it('Soft unlocks L1→L2→L3 with proven MFE', () => {
    const soft: [number, number, number] = [1.2, 1.8, 2.2];
    expect(unlockedSoftLayer(0, soft)).toBe(1);
    expect(unlockedSoftLayer(1.2, soft)).toBe(2);
    expect(unlockedSoftLayer(1.8, soft)).toBe(3);
    expect(activeSoftAbs(0).layer).toBe(1);
    expect(activeSoftAbs(1.5).layer).toBe(2);
    expect(activeSoftAbs(2.0).layer).toBe(3);
  });

  it('layered HardInv tighter without MFE than fat L3', () => {
    const entry = 2000;
    const l1 = layeredHardInvDistance(entry, 0, 'TREND_UP');
    const l3 = layeredHardInvDistance(entry, 5, 'TREND_UP');
    expect(l1.layer).toBe(1);
    expect(l3.layer).toBe(3);
    expect(l1.dist).toBeLessThan(l3.dist);
    // Legacy hardInvStopDistance = L3 (broker / sizing)
    expect(hardInvStopDistance(entry, 'TREND_UP')).toBeCloseTo(l3.dist, 5);
  });

  it('Target L1/L2 bank when MFE never stretched to fat L3', () => {
    const hit1 = targetLayerHit({
      fav: 2.6,
      mfe: 2.7,
      execFav: 2.6,
      minBank: 1.2,
      targetDists: [2.5, 3.5, 5.0],
    });
    expect(hit1?.layer).toBe(1);
    const hit2 = targetLayerHit({
      fav: 3.6,
      mfe: 3.7,
      execFav: 3.6,
      minBank: 1.2,
      targetDists: [2.5, 3.5, 5.0],
    });
    expect(hit2?.layer).toBe(2);
    // Stretched toward L3 — wait for L3 / Peak, no premature L2
    const wait = targetLayerHit({
      fav: 3.6,
      mfe: 4.5,
      execFav: 3.6,
      minBank: 1.2,
      targetDists: [2.5, 3.5, 5.0],
    });
    expect(wait).toBeNull();
  });

  it('decideBestOutcomeExit Soft L1 HardInv when no MFE', () => {
    const now = Date.now();
    const d = decideBestOutcomeExit(
      {
        open_side: 'SELL',
        entry_price: 2000,
        entry_at: new Date(now - 30_000).toISOString(),
        mfe: 0.2,
        mae: 1.3,
        peak_retention: null,
        entry_regime: 'TREND_DOWN',
        hardinv_breach_since_ms: now - 10_000,
      },
      2001.3, // SELL UPL = 2000-2001.3 = -1.3 → beyond Soft L1 ~1.2
      'live_loss',
      now,
      { bid: 2001.2, ask: 2001.4 }
    );
    expect(d.exit).toBe(true);
    expect(d.reason).toMatch(/Soft L1/);
  });

  it('suggestLayersFromExcursions keeps L1≤L2≤L3 and T≥Soft', () => {
    const cur = readSoftTargetLayers();
    const next = suggestLayersFromExcursions(
      [1.5, 2.0, 2.8, 4.0, 5.5],
      [1.0, 1.4, 1.9, 2.3],
      cur
    );
    expect(next.soft[0]!).toBeLessThanOrEqual(next.soft[1]!);
    expect(next.soft[1]!).toBeLessThanOrEqual(next.soft[2]!);
    expect(next.target[0]!).toBeGreaterThanOrEqual(next.soft[0]!);
    expect(next.target[2]!).toBeGreaterThanOrEqual(next.soft[2]!);
  });
});
