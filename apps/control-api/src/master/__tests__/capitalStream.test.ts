import { describe, expect, it, vi } from 'vitest';
import {
  capitalStreamEndpoint,
  parseCapitalStreamQuote,
} from '../capitalStream.js';
import { modifyCapitalPosition } from '../../services/capitalCom.js';
import { PaperBroker } from '../broker.js';
import { PositionManager } from '../positionManager.js';
import { MasterPipeline } from '../pipeline.js';

describe('Capital stream parse', () => {
  it('parses quote destination with ofr', () => {
    const q = parseCapitalStreamQuote(
      JSON.stringify({
        status: 'OK',
        destination: 'quote',
        payload: {
          epic: 'GOLD',
          product: 'CFD',
          bid: 4400.1,
          ofr: 4400.4,
          timestamp: 1660297190627,
        },
      })
    );
    expect(q).toMatchObject({
      epic: 'GOLD',
      bid: 4400.1,
      offer: 4400.4,
    });
    expect(q!.mid).toBeCloseTo(4400.25, 5);
  });

  it('ignores non-quote messages', () => {
    expect(
      parseCapitalStreamQuote(JSON.stringify({ destination: 'ping', payload: {} }))
    ).toBeNull();
  });

  it('picks demo vs live stream host', () => {
    expect(capitalStreamEndpoint('https://demo-api-capital.backend-capital.com')).toContain(
      'demo-streaming'
    );
    expect(capitalStreamEndpoint('https://api-capital.backend-capital.com')).toContain(
      'api-streaming'
    );
  });
});

describe('native Capital trailingStop modify', () => {
  it('sends trailingStop+stopDistance without stopLevel', async () => {
    const put = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: { dealReference: 'ref-1' },
      text: '',
    }));
    const session = {
      put,
      base: 'https://demo-api-capital.backend-capital.com',
      apiKey: 'k',
      cst: 'c',
      securityToken: 's',
    } as any;
    const res = await modifyCapitalPosition(session, {
      dealId: 'deal-1',
      trailingStop: true,
      stopDistance: 0.5,
    });
    expect(res.ok).toBe(true);
    expect(put).toHaveBeenCalledWith(
      '/api/v1/positions/deal-1',
      expect.objectContaining({ trailingStop: true, stopDistance: 0.5 })
    );
    expect(put.mock.calls[0]![1]).not.toHaveProperty('stopLevel');
  });
});

describe('native trail arm on scalp chase', () => {
  it('arms native trailing_stop once in deep profit', async () => {
    const broker = new PaperBroker();
    await broker.connect();
    const entry = 4400;
    const mark = entry + 40;
    broker.setQuote({
      bid: mark - 0.05,
      ask: mark + 0.05,
      mid: mark,
      spread: 0.1,
      epic: 'GOLD',
      ts_ms: Date.now(),
    });
    const placed = await broker.placeOrder({
      intent_id: 'native-trail-aaaaaaaaaaaa',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      stop_level: entry - 440,
      profit_level: entry + 80,
    });
    // Capture trailing_stop calls
    const mods: unknown[] = [];
    const orig = broker.modifyPosition!.bind(broker);
    broker.modifyPosition = async (input) => {
      mods.push(input);
      return orig(input);
    };
    const pipe = new MasterPipeline('PAPER');
    const pm = new PositionManager();
    pm.register({
      position_id: placed.position_id!,
      opportunity_id: 'opp-nt',
      intent_id: 'nt-1',
      epic: 'GOLD',
      side: 'BUY',
      size: 0.1,
      entry,
      stop_loss: entry - 440,
      take_profit: entry + 80,
      decision: {
        decision_id: 'd',
        kind: 'BUY',
        side: 'BUY',
        score: 0.7,
        block_reason: null,
        buy: null as never,
        sell: null as never,
        analysis: {
          regime: 'TREND',
          market_state: 't',
          momentum_score: 0.5,
          momentum_dir: 'UP',
          trend_dir: 'UP',
          trend_strength: 0.8,
          structure_bias: 'BULLISH',
          swing_high: entry + 50,
          swing_low: entry - 50,
          buy_pressure: 0.7,
          sell_pressure: 0.3,
          behavior_bull: 0.7,
          behavior_bear: 0.3,
          impact_score: 0.5,
          context_quality: 0.8,
          volatility: 0.001,
          atr: 2,
        },
        expectancy: null,
      },
    });
    await pm.manageTick({
      broker,
      pipeline: pipe,
      quote: {
        bid: mark - 0.05,
        ask: mark + 0.05,
        mid: mark,
        spread: 0.1,
        ts_ms: Date.now(),
      },
      instrument_point_value: 1,
      scalp_pct_chase: true,
      scalp_lock_pct: 0.2,
      breakeven_progress: 0,
      max_hold_ms: 0,
      allow_close: false,
    });
    expect(pm.get(placed.position_id!)!.native_trail_armed).toBe(true);
    expect(
      mods.some(
        (m: any) => m.trailing_stop === true && Number(m.stop_distance) > 0
      )
    ).toBe(true);
  });
});
