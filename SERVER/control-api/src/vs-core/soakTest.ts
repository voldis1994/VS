/**
 * Memory / soak — process many market events; retained state must stay bounded.
 */

import { MarketCore } from './marketCore.js';
import { FeedManager } from './feedManager.js';
import { EventBus } from './eventBus.js';
import { getIncidentCenter, resetIncidentCenterForTests } from './incidentCenter.js';

export type SoakResult = {
  ok: boolean;
  events: number;
  heap_used_mb_start: number;
  heap_used_mb_end: number;
  growth_mb: number;
  bus_retained: number;
  detail: string;
};

function heapMb(): number {
  return Math.round((process.memoryUsage().heapUsed / (1024 * 1024)) * 10) / 10;
}

export async function runSoakTest(opts?: {
  events?: number;
  maxGrowthMb?: number;
}): Promise<SoakResult> {
  const n = opts?.events ?? 20_000;
  const maxGrowth = opts?.maxGrowthMb ?? 80;
  resetIncidentCenterForTests();
  const market = new MarketCore(60_000);
  const feeds = new FeedManager(60_000);
  feeds.defineSource('capital', 'PRIMARY');
  const bus = new EventBus(500); // hard cap history
  const start = heapMb();

  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    const ts = new Date(t0 + i).toISOString();
    const bid = 2400 + (i % 50) * 0.01;
    feeds.ingest({
      source: 'capital',
      epic: 'GOLD',
      bid,
      ask: bid + 0.2,
      source_timestamp: ts,
      now: t0 + i,
    });
    market.ingest({
      epic: 'GOLD',
      bid,
      ask: bid + 0.2,
      source: 'capital',
      source_timestamp: ts,
      source_sequence: i,
      market_status: 'TRADEABLE',
      now: t0 + i,
    });
    if (i % 100 === 0) {
      await bus.emit('MarketTickReceived', {
        source: 'soak',
        payload: { i },
      });
    }
  }

  // Force GC hint if available
  try {
    (global as unknown as { gc?: () => void }).gc?.();
  } catch {
    /* optional */
  }
  const end = heapMb();
  const growth = Math.round((end - start) * 10) / 10;
  const ok = growth <= maxGrowth && bus.recent(10_000).length <= 500;
  if (!ok) {
    getIncidentCenter().raise({
      severity: 'CRITICAL',
      component: 'soak',
      error_code: 'MEMORY_GROWTH',
      reason: `heap growth ${growth}MB > ${maxGrowth}MB`,
    });
  }
  return {
    ok,
    events: n,
    heap_used_mb_start: start,
    heap_used_mb_end: end,
    growth_mb: growth,
    bus_retained: bus.recent(10_000).length,
    detail: `growth=${growth}MB bus=${bus.recent(10_000).length}`,
  };
}
