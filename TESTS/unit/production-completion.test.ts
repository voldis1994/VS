import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { classifyBrokerConfig } from '../../SERVER/broker-gateway/capital/health.ts';
import { mapCapitalError } from '../../SERVER/broker-gateway/capital/canonical.ts';
import { classifyRegime, applyHysteresis } from '../../SERVER/regime-engine/src/classifier.ts';
import {
  macd,
  adx,
  volatility,
  supportResistance,
  trendStrength,
} from '../../SERVER/indicators/src/index.ts';
import { atrStop, structureStop, positionSize } from '../../SERVER/risk-engine/src/index.ts';
import { eligibleStrategies, STRATEGY_REGISTRY } from '../../SERVER/strategy-engine/src/index.ts';
import { transition } from '../../SERVER/execution-engine/src/orderStateMachine.ts';
import { MarketFeedBook, aggregateCandles } from '../../SERVER/market-data/src/index.ts';
import { buildSignal, recordNoTrade, isSignalExpired } from '../../SERVER/signal-engine/src/index.ts';
import { evaluateRisk } from '../../SERVER/control-api/src/vs-core/riskCore.ts';

describe('broker CONFIG_REQUIRED', () => {
  const prev: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of [
      'CAPITAL_API_KEY',
      'CAPITAL_LOGIN',
      'CAPITAL_PASSWORD',
      'CAPITAL_API_KEY_ID',
      'CAPITAL_IDENTIFIER',
      'CAPITAL_API_PASSWORD',
    ]) {
      prev[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('returns CONFIG_REQUIRED without inventing CONNECTED', () => {
    const h = classifyBrokerConfig();
    expect(h.state).toBe('CONFIG_REQUIRED');
    expect(h.secrets_present).toBe(false);
  });

  it('maps capital errors without leaking raw objects', () => {
    const e = mapCapitalError({ httpStatus: 429, bodyCode: 'rate.limit', message: 'slow down' });
    expect(e.broker).toBe('capital');
    expect(e.retryable).toBe(true);
  });
});

describe('indicators ADX/MACD/vol', () => {
  it('computes macd/adx/volatility on rising series', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i * 0.2);
    const highs = closes.map((c) => c + 0.5);
    const lows = closes.map((c) => c - 0.5);
    expect(macd(closes)).not.toBeNull();
    expect(adx(highs, lows, closes, 14)).not.toBeNull();
    expect(volatility(closes, 14)).not.toBeNull();
    expect(trendStrength(closes, 10, 1)).not.toBeNull();
    // Need local peaks/valleys for swing S/R
    const zigzagHighs = Array.from({ length: 21 }, (_, i) =>
      i % 4 === 2 ? 110 : i % 4 === 0 ? 100 : 105
    );
    const zigzagLows = zigzagHighs.map((h) => h - 2);
    const sr = supportResistance(zigzagHighs, zigzagLows, 2);
    expect(sr.resistance).not.toBeNull();
    expect(sr.support).not.toBeNull();
  });
});

describe('market feed lifecycle', () => {
  it('rejects duplicates and aggregates candles', () => {
    const book = new MarketFeedBook({ maxQuoteAgeMs: 5000 });
    book.setLifecycle('CONNECTING');
    const ts = new Date().toISOString();
    const a = book.ingest({
      symbol: 'XAUUSD',
      bid: 2000,
      ask: 2000.2,
      source: 'test',
      sourceTimestamp: ts,
      sequence: 1,
    });
    expect(a.accepted).toBe(true);
    const dup = book.ingest({
      symbol: 'XAUUSD',
      bid: 2000,
      ask: 2000.2,
      source: 'test',
      sourceTimestamp: ts,
      sequence: 1,
    });
    expect(dup.accepted).toBe(false);
    expect(book.getLifecycle()).toBe('LIVE');
    const candles = aggregateCandles([a.book!.lastValidQuote!], 'M1');
    expect(candles.length).toBe(1);
  });
});

describe('regime breakout + hysteresis', () => {
  it('emits breakout candidate above resistance', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i * 0.1);
    closes[closes.length - 1] = 200;
    const r = classifyRegime({
      closes,
      highs: closes.map((c) => c + 1),
      lows: closes.map((c) => c - 1),
      atr: 2,
      atrBaseline: 1,
      spread: 0.1,
      maxSpread: 1,
      quoteAgeMs: 10,
      maxQuoteAgeMs: 5000,
      marketAvailable: true,
      brokerConnected: true,
      reconciliationPending: false,
      riskLimitHit: false,
      killSwitch: false,
      resistance: 150,
    });
    expect(String(r.regime)).toMatch(/BREAKOUT_UP/);
  });

  it('hysteresis waits residence', () => {
    const m0 = {
      current: 'RANGE' as const,
      candidate: null,
      candidateSince: null,
      lastTransition: null,
      confidence: 0.4,
    };
    const next = {
      regime: 'TREND_UP' as const,
      confidence: 0.8,
      evidence: [],
      invalidations: [],
    };
    const m1 = applyHysteresis(m0, next, 1000, 5000);
    expect(m1.current).toBe('RANGE');
    expect(m1.candidate).toBe('TREND_UP');
    const m2 = applyHysteresis(m1, next, 7000, 5000);
    expect(m2.current).toBe('TREND_UP');
  });
});

describe('strategy eligibility + execution + signals + risk', () => {
  it('registers all required strategies', () => {
    const ids = STRATEGY_REGISTRY.map((s) => s.id);
    expect(ids).toContain('trendContinuation');
    expect(ids).toContain('trendPullback');
    expect(ids).toContain('breakoutContinuation');
    expect(ids).toContain('reversalConfirmation');
    expect(ids).toContain('noTrade');
  });

  it('trendContinuation eligible for TREND_UP', () => {
    expect(eligibleStrategies('TREND_UP', 0.7)).toContain('trendContinuation');
    expect(eligibleStrategies('NO_TRADE', 1)).toContain('noTrade');
  });

  it('order state machine rejects illegal jumps', () => {
    expect(transition('CREATED', 'FILLED').ok).toBe(false);
    expect(transition('CREATED', 'VALIDATING').ok).toBe(true);
  });

  it('atr/structure stop + sizing', () => {
    const s = atrStop({ direction: 'SHORT', entry: 100, atr: 2, multiplier: 1 });
    expect('stop' in s && s.stop).toBe(102);
    const st = structureStop({ direction: 'LONG', entry: 100, structureLevel: 95 });
    expect('finalStop' in st && st.finalStop).toBe(95);
    const sz = positionSize({
      equity: 10000,
      riskFraction: 0.01,
      entry: 100,
      stop: 99,
      direction: 'LONG',
    });
    expect('size' in sz && sz.size).toBe(100);
  });

  it('signal NO_TRADE is recordable; expired signals detected', () => {
    const nt = recordNoTrade({
      strategy: 'noTrade',
      regime: 'NO_TRADE',
      reasons: ['MARKET_STALE'],
    });
    expect(nt.result).toBe('NO_TRADE');
    const sig = buildSignal({
      signalId: 's1',
      symbol: 'XAUUSD',
      direction: 'NONE',
      strategy: 'noTrade',
      regime: 'NO_TRADE',
      timeframe: 'M1',
      entryReference: null,
      stopReference: null,
      targetReference: null,
      confidence: 1,
      ttlMs: -1,
      evidence: ['MARKET_STALE'],
    });
    expect(isSignalExpired(sig)).toBe(true);
  });

  it('kill switch denies risk', () => {
    const r = evaluateRisk({
      client_id: 1,
      account_id: 1,
      epic: 'GOLD',
      direction: 'BUY',
      size: 0.1,
      client_trading_enabled: true,
      market_open: true,
      feed_fresh: true,
      feed_offline: false,
      spread: 0.1,
      max_spread: 1,
      has_open_position: false,
      has_duplicate_intent: false,
      session_healthy: true,
      time_sync_ok: true,
      reconcile_clean: true,
      stop_attached: true,
      operating_mode: 'DEMO',
      live_trading_enabled: false,
      kill_switch_active: true,
    });
    expect(r.ok).toBe(false);
  });
});
