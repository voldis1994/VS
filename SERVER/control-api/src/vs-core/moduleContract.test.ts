import { describe, expect, it } from 'vitest';

/**
 * Production module-contract gate — same import style as physical Debian
 * control-api routes (index.js path under tsx).
 */
describe('market-intelligence production contract', () => {
  it('exports every symbol Control API imports', async () => {
    const mi = await import('../../../core/market-intelligence/src/index.js');
    const required = [
      'buildMarketStateVector',
      'validateMultiFeed',
      'rawTickFromParts',
      'evaluateTrendContinuationSetup',
      'computeProtectiveStop',
      'computeLotSize',
      'buildTradeExplanation',
    ] as const;
    for (const name of required) {
      expect(typeof (mi as Record<string, unknown>)[name], name).toBe('function');
    }
  });

  it('named ESM import of buildMarketStateVector resolves', async () => {
    const { buildMarketStateVector } = await import(
      '../../../core/market-intelligence/src/index.js'
    );
    expect(typeof buildMarketStateVector).toBe('function');
    const v = buildMarketStateVector({
      instrument: 'TEST',
      candles: [],
      asOf: new Date().toISOString(),
    });
    expect(v.instrument).toBe('TEST');
    expect(['INSUFFICIENT_DATA', 'FEED_UNAVAILABLE']).toContain(v.status);
    expect(v.status).not.toBe('OK');
  });
});

describe('production route module loads', () => {
  it('marketIntelligence route module imports without SyntaxError', async () => {
    await expect(import('../routes/marketIntelligence.js')).resolves.toBeTruthy();
  });
});
