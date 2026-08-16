import { describe, expect, it } from 'vitest';

/**
 * Production module-contract gate — same ESM import style as physical Debian
 * (tsx resolves `.js` paths to `.ts` sources under /opt/vs-server).
 *
 * A missing named export MUST fail CI before deployment.
 */

const MI_REQUIRED = [
  'buildMarketStateVector',
  'validateMultiFeed',
  'rawTickFromParts',
  'evaluateTrendContinuationSetup',
  'computeProtectiveStop',
  'computeLotSize',
  'buildTradeExplanation',
] as const;

describe('market-intelligence production contract', () => {
  it('exports every symbol Control API imports', async () => {
    const mi = await import('../../../core/market-intelligence/src/index.js');
    for (const name of MI_REQUIRED) {
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

describe('production core modules load (runAppliance chain)', () => {
  it('imports market-intelligence', async () => {
    await expect(import('../../../core/market-intelligence/src/index.js')).resolves.toBeTruthy();
  });

  it('imports market-data', async () => {
    const mod = await import('../../../core/market-data/src/index.js');
    expect(typeof mod.validateTick).toBe('function');
    expect(typeof mod.isStale).toBe('function');
    expect(mod.MarketFeedBook).toBeTruthy();
  });

  it('imports strategy', async () => {
    const mod = await import('../../../core/strategy/src/index.js');
    expect(Array.isArray(mod.STRATEGY_REGISTRY)).toBe(true);
  });

  it('imports risk', async () => {
    const mod = await import('../../../core/risk/src/index.js');
    expect(typeof mod.atrStop).toBe('function');
    expect(typeof mod.positionSize).toBe('function');
  });

  it('imports execution', async () => {
    const mod = await import('../../../core/execution/src/index.js');
    expect(typeof mod.canTransition).toBe('function');
    expect(typeof mod.transition).toBe('function');
  });

  it('imports reconciliation', async () => {
    const mod = await import('../../../core/reconciliation/src/index.js');
    expect(typeof mod.compareSets).toBe('function');
  });

  it('imports supervisor', async () => {
    const mod = await import('../../../core/supervisor/src/index.js');
    expect(typeof mod.evaluateSupervisor).toBe('function');
    expect(typeof mod.evaluateTradingReady).toBe('function');
  });
});

describe('production control-api modules load', () => {
  it('marketIntelligence route imports without SyntaxError', async () => {
    await expect(import('../routes/marketIntelligence.js')).resolves.toBeTruthy();
  });

  it('system routes import without SyntaxError', async () => {
    await expect(import('../routes/system.js')).resolves.toBeTruthy();
  });

  it('runAppliance dependency modules import', async () => {
    await expect(import('./boot.js')).resolves.toBeTruthy();
    await expect(import('./readiness.js')).resolves.toBeTruthy();
    await expect(import('./runtimeHealth.js')).resolves.toBeTruthy();
    await expect(import('./versions.js')).resolves.toBeTruthy();
    await expect(import('../db/pool.js')).resolves.toBeTruthy();
    await expect(import('../db/migrate.js')).resolves.toBeTruthy();
  });

  it('runtimeBuildInfo exposes VS-CORE identity fields', async () => {
    const { runtimeBuildInfo } = await import('../services/runtimeBuild.js');
    const info = runtimeBuildInfo();
    expect(info.service).toBe('VS-CORE');
    expect(info.server_id).toBeTruthy();
    expect(info.build_commit).toBeTruthy();
    expect(info.api_version).toBe('v1');
  });
});
