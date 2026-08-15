import { describe, it, expect } from 'vitest';
import { collectHostSystemSnapshot, formatBytesPair } from './hostTelemetry.js';
import { renderCoreTui, servicesFromProbes } from './coreTui.js';
import { evaluateReadiness, probe } from './readiness.js';
import { FeedManager } from './feedManager.js';

describe('hostTelemetry — real OS data', () => {
  it('reads non-hardcoded RAM/CPU/SSD from this Linux host', () => {
    const s = collectHostSystemSnapshot({
      cpuSampleMs: 40,
      probeNetwork: false,
      dataRoot: '/',
    });
    expect(s.os.toLowerCase()).toContain('linux');
    expect(s.ram_total_bytes).not.toBeNull();
    expect(s.ram_total_bytes!).toBeGreaterThan(100_000_000);
    expect(s.ssd_total_bytes).not.toBeNull();
    expect(s.ssd_total_bytes!).toBeGreaterThan(100_000_000);
    expect(s.cpu_percent).not.toBeNull();
    expect(s.cpu_percent!).toBeGreaterThanOrEqual(0);
    expect(s.cpu_percent!).toBeLessThanOrEqual(100);
    expect(s.uptime_seconds).toBeGreaterThan(0);
    // Must not look like the reference image fake constants
    expect(s.uptime_human).not.toBe('18d 07h 42m');
  });

  it('formatBytesPair returns NO DATA when missing', () => {
    expect(formatBytesPair(null, null)).toBe('NO DATA');
  });
});

describe('coreTui', () => {
  it('renders NO DATA for missing capital counts — never invents numbers', () => {
    const probes = [
      probe('NETWORK', 'OK', 'ok'),
      probe('TIME', 'OK', 'ok'),
      probe('STORAGE', 'OK', 'ok'),
      probe('DATABASE', 'OK', 'ok'),
      probe('MARKET', 'OK', 'ok'),
      probe('CAPITAL', 'ERROR', 'unverified', 'CAPITAL_UNVERIFIED'),
      probe('STRATEGY', 'OK', 'ok'),
      probe('RISK', 'OK', 'ok'),
      probe('EXECUTION', 'OK', 'ok'),
      probe('RECONCILIATION', 'OK', 'ok'),
    ];
    const readiness = evaluateReadiness(probes);
    const feeds = new FeedManager();
    feeds.defineSource('capital', 'PRIMARY');
    feeds.markOffline('capital', 'GOLD');
    const text = renderCoreTui({
      host: collectHostSystemSnapshot({ cpuSampleMs: 30, probeNetwork: false }),
      readiness,
      services: servicesFromProbes(probes),
      feeds: feeds.snapshot('GOLD'),
      capital: {
        connection: 'UNVERIFIED',
        accounts: null,
        positions: null,
        working_orders: null,
        last_sync: null,
        latency_ms: null,
      },
      clients: {
        registered: null,
        active: null,
        trading: null,
        paused: null,
        disabled: null,
      },
      incidents: { critical: 0, error: 0, warning: 0, info: 0 },
      events: [],
    });
    expect(text).toContain('VS CORE');
    expect(text).toContain('CORE SERVER — MAIN BRAIN');
    expect(text).toContain('NO DATA');
    expect(text).toContain('PRIMARY_FEED_OFFLINE');
    expect(text).not.toContain('$72,058');
    expect(text).toContain('Trading Core runs independently');
  });
});
