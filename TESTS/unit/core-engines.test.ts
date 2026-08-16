import { describe, it, expect } from 'vitest';
import { sma, ema, atr, rsi, slope } from '../../SERVER/indicators/src/index.ts';
import { validateTick, isStale } from '../../SERVER/market-data/src/types.ts';
import { classifyRegime } from '../../SERVER/regime-engine/src/classifier.ts';
import { atrStop, riskRewardTarget, positionSize } from '../../SERVER/risk-engine/src/stops/atrStop.ts';
import {
  evaluateTradingReady,
  evaluateProcessReady,
  createInitialRegistry,
  setSubsystem,
} from '../../SERVER/supervisor/src/state.ts';

describe('indicators', () => {
  it('sma / ema / slope are deterministic', () => {
    const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(sma(v, 5)).toBe(8);
    expect(ema(v, 3)).not.toBeNull();
    expect(slope(v, 5)).toBeGreaterThan(0);
  });

  it('atr and rsi require enough data', () => {
    expect(atr([1], [1], [1], 14)).toBeNull();
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i * 0.5);
    const highs = closes.map((c) => c + 1);
    const lows = closes.map((c) => c - 1);
    expect(atr(highs, lows, closes, 5)).toBeGreaterThan(0);
    expect(rsi(closes, 14)).not.toBeNull();
  });
});

describe('market-data validation', () => {
  it('rejects ask < bid and never invents', () => {
    const bad = validateTick({
      symbol: 'XAUUSD',
      bid: 10,
      ask: 9,
      source: 'test',
      sourceTimestamp: new Date().toISOString(),
    });
    expect(bad.ok).toBe(false);
  });

  it('accepts valid tick and detects stale', () => {
    const ok = validateTick({
      symbol: 'XAUUSD',
      bid: 2300,
      ask: 2300.5,
      source: 'test',
      sourceTimestamp: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(isStale(ok.tick, Date.now(), 5_000)).toBe(true);
      expect(isStale(ok.tick, Date.now(), 120_000)).toBe(false);
    }
  });
});

describe('regime classifier', () => {
  it('NO_TRADE when market unavailable', () => {
    const r = classifyRegime({
      closes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22],
      highs: Array(22).fill(3),
      lows: Array(22).fill(1),
      atr: 1,
      atrBaseline: 1,
      spread: 0.1,
      maxSpread: 1,
      quoteAgeMs: 100,
      maxQuoteAgeMs: 5000,
      marketAvailable: false,
      brokerConnected: true,
      reconciliationPending: false,
      riskLimitHit: false,
      killSwitch: false,
    });
    expect(r.regime).toBe('NO_TRADE');
    expect(r.no_trade_reasons).toContain('MARKET_OFFLINE');
  });

  it('trend up on rising series', () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + i);
    const r = classifyRegime({
      closes,
      highs: closes.map((c) => c + 0.5),
      lows: closes.map((c) => c - 0.5),
      atr: 1,
      atrBaseline: 1,
      spread: 0.1,
      maxSpread: 1,
      quoteAgeMs: 100,
      maxQuoteAgeMs: 5000,
      marketAvailable: true,
      brokerConnected: true,
      reconciliationPending: false,
      riskLimitHit: false,
      killSwitch: false,
    });
    expect(r.regime).toBe('TREND_UP');
    expect(r.confidence).toBeGreaterThan(0.4);
  });
});

describe('risk stops / sizing', () => {
  it('atr stop and RR target', () => {
    const s = atrStop({ direction: 'LONG', entry: 100, atr: 2, multiplier: 1.5 });
    expect('stop' in s).toBe(true);
    if ('stop' in s) {
      expect(s.stop).toBe(97);
      const t = riskRewardTarget({
        direction: 'LONG',
        entry: 100,
        stop: s.stop,
        rewardMultiple: 2,
      });
      expect('target' in t).toBe(true);
      if ('target' in t) expect(t.target).toBe(106);
    }
  });

  it('position size from equity risk', () => {
    const p = positionSize({
      equity: 10_000,
      riskFraction: 0.01,
      entry: 100,
      stop: 98,
      direction: 'LONG',
    });
    expect('size' in p).toBe(true);
    if ('size' in p) expect(p.size).toBe(50);
  });
});

describe('supervisor trading vs process readiness', () => {
  it('trading stays false when live off', () => {
    const t = evaluateTradingReady({
      liveTradingEnabled: false,
      brokerConnected: true,
      marketDataLive: true,
      marketStale: false,
      databaseOk: true,
      reconciliationOk: true,
      riskConfigValid: true,
      killSwitchActive: false,
      operatorAuthorized: true,
    });
    expect(t.trading_ready).toBe(false);
    expect(t.blockers).toContain('LIVE_TRADING_DISABLED');
  });

  it('process ready requires postgres + control_api READY', () => {
    const reg = createInitialRegistry();
    setSubsystem(reg, 'configuration', 'READY', 'ok');
    setSubsystem(reg, 'secrets', 'READY', 'ok');
    setSubsystem(reg, 'postgresql', 'READY', 'ok');
    setSubsystem(reg, 'control_api', 'READY', 'ok');
    expect(evaluateProcessReady(reg)).toBe(true);
    setSubsystem(reg, 'control_api', 'FAILED', 'down', 'x');
    expect(evaluateProcessReady(reg)).toBe(false);
  });
});
