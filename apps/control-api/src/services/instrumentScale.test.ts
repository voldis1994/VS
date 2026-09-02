import { describe, expect, it } from 'vitest';
import { edgeEps, minSwingSpan, scaleExitFloors, scaleFromGold } from './instrumentScale.js';
import { exitParamsForTrade } from './playbooks.js';

describe('instrumentScale', () => {
  it('scaleFromGold preserves Gold reference magnitude', () => {
    expect(scaleFromGold(4430, 1.2)).toBeCloseTo(1.2, 2);
    expect(scaleFromGold(4430, 4.0)).toBeCloseTo(4.0, 2);
  });

  it('scaleFromGold shrinks thresholds for EURUSD', () => {
    const eur = scaleFromGold(1.085, 1.2);
    expect(eur).toBeLessThan(0.001);
    expect(eur).toBeGreaterThan(0.0002);
  });

  it('edgeEps is not stuck at 0.8 on FX', () => {
    expect(edgeEps(1.085, 0.002)).toBeLessThan(0.001);
    expect(edgeEps(4430, 3)).toBeGreaterThan(0.5);
  });

  it('minSwingSpan detects flat EUR/USD compression', () => {
    expect(minSwingSpan(1.16)).toBeGreaterThan(0.0002);
    expect(0.0001).toBeLessThan(minSwingSpan(1.16));
  });

  it('exitParamsForTrade scales CONTINUATION TP for EURUSD vs Gold', () => {
    const gold = exitParamsForTrade('SCALP', 'CONTINUATION', 4430);
    const eur = exitParamsForTrade('SCALP', 'CONTINUATION', 1.085);
    expect(gold.tpFloor).toBeCloseTo(4.0, 1);
    expect(eur.tpFloor).toBeLessThan(0.002);
    expect(eur.tpFloor).toBeGreaterThan(0.0005);
  });

  it('scaleExitFloors scales playbook base floors', () => {
    const scaled = scaleExitFloors(1.085, { tpFloor: 0.22, slFloor: 0.19, mfeFloorAbs: 0.15 });
    expect(scaled.tpFloor).toBeLessThan(0.001);
  });
});
