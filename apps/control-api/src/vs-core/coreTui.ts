/**
 * VS CORE Terminal UI — lightweight monospace status screen.
 * Trading continues if this renderer exits (separate from supervisor services).
 * Refresh ~1 Hz — never drives market processing rate.
 */

import {
  collectHostSystemSnapshot,
  formatBytesPair,
  type HostSystemSnapshot,
} from './hostTelemetry.js';
import type { ReadinessReport, ProbeResult } from './readiness.js';
import type { VsEvent } from './eventBus.js';
import type { FeedManagerSnapshot } from './feedManager.js';
import { CORE_VERSION, STRATEGY_VERSION } from './versions.js';

export type CoreTuiModel = {
  host: HostSystemSnapshot;
  readiness: ReadinessReport;
  services: Array<{ name: string; status: string; detail: string }>;
  feeds: FeedManagerSnapshot | null;
  capital: {
    connection: string;
    accounts: number | null;
    positions: number | null;
    working_orders: number | null;
    last_sync: string | null;
    latency_ms: number | null;
  };
  clients: {
    registered: number | null;
    active: number | null;
    trading: number | null;
    paused: number | null;
    disabled: number | null;
  };
  incidents: {
    critical: number;
    error: number;
    warning: number;
    info: number;
  };
  events: VsEvent[];
};

function pad(label: string, width = 18): string {
  if (label.length >= width) return label.slice(0, width);
  return label + '.'.repeat(width - label.length);
}

function statusCell(s: string): string {
  return s.padEnd(12, ' ');
}

function line(label: string, value: string, status: string): string {
  return `${pad(label)} ${value.padEnd(28, ' ')} ${status}`;
}

function overallStatus(r: ReadinessReport): string {
  if (r.state === 'READY') return 'OPERATIONAL';
  if (r.state === 'DEGRADED') return 'DEGRADED';
  return 'NOT READY';
}

export function renderCoreTui(model: CoreTuiModel): string {
  const h = model.host;
  const r = model.readiness;
  const green = (s: string) => s; // plain TUI — no ANSI required for headless logs

  const header = [
    '================================================================================',
    '  VS CORE',
    '  CORE SERVER — MAIN BRAIN',
    '================================================================================',
    `  SERVER ID: ${h.server_id}`,
    `  UPTIME:    ${h.uptime_human}`,
    `  TIME UTC:  ${h.time_utc}`,
    `  STATUS:    ${overallStatus(r)}${r.reason_code ? ` (${r.reason_code})` : ''}`,
    `  CORE ${CORE_VERSION}  STRATEGY ${STRATEGY_VERSION}`,
    '',
  ];

  const system = [
    '[ SYSTEM ]',
    line('OS', h.os, 'OK'),
    line(
      'CPU',
      h.cpu_percent == null ? 'NO DATA' : `${h.cpu_percent}%`,
      h.cpu_status
    ),
    line('RAM', formatBytesPair(h.ram_used_bytes, h.ram_total_bytes), h.ram_status),
    line('SSD', formatBytesPair(h.ssd_used_bytes, h.ssd_total_bytes), h.ssd_status),
    line(
      'NETWORK',
      !h.network_online
        ? 'OFFLINE'
        : h.network_latency_ms == null
          ? 'ONLINE (latency NO DATA)'
          : `ONLINE ${h.network_latency_ms}ms`,
      h.network_status
    ),
    line(
      'TIME SYNC',
      h.time_sync_ok == null ? 'NO DATA' : h.time_sync_ok ? 'OK UTC' : 'NOT SYNCED',
      h.time_sync_status
    ),
    '',
  ];

  const services = [
    '[ CORE SERVICES ]',
    ...model.services.map((s) =>
      line(s.name.toUpperCase(), s.detail.slice(0, 28), statusCell(s.status).trim())
    ),
    '',
  ];

  const feedsBlock: string[] = ['[ MARKET FEEDS ]'];
  if (!model.feeds) {
    feedsBlock.push(line('FEEDS', 'NO DATA', 'NO_DATA'));
  } else {
    const f = model.feeds;
    if (f.primary) {
      feedsBlock.push(
        line(
          `${f.primary.source} (PRIMARY)`,
          `${f.primary.status} ${f.primary.age_ms}ms age`,
          f.primary.status
        )
      );
    } else {
      feedsBlock.push(line('PRIMARY', 'MISSING', 'ERROR'));
    }
    for (const q of [...f.confirmation, ...f.reference, ...f.fallback]) {
      feedsBlock.push(
        line(
          `${q.source} (${q.role})`,
          `${q.status} ${q.age_ms}ms age`,
          q.status
        )
      );
    }
    if (!f.allows_execution && f.block_reason) {
      feedsBlock.push(`  BLOCK: ${f.block_reason}`);
    }
  }
  feedsBlock.push('');

  const cap = model.capital;
  const capital = [
    '[ CAPITAL.COM ]',
    line('CONNECTION', cap.connection, cap.connection),
    line(
      'ACCOUNTS',
      cap.accounts == null ? 'NO DATA' : String(cap.accounts),
      cap.accounts == null ? 'NO_DATA' : 'OK'
    ),
    line(
      'POSITIONS',
      cap.positions == null ? 'NO DATA' : String(cap.positions),
      cap.positions == null ? 'NO_DATA' : 'OK'
    ),
    line(
      'WORKING ORDERS',
      cap.working_orders == null ? 'NO DATA' : String(cap.working_orders),
      cap.working_orders == null ? 'NO_DATA' : 'OK'
    ),
    line('LAST SYNC', cap.last_sync || 'NO DATA', cap.last_sync ? 'OK' : 'NO_DATA'),
    line(
      'LATENCY',
      cap.latency_ms == null ? 'NO DATA' : `${cap.latency_ms}ms`,
      cap.latency_ms == null ? 'NO_DATA' : 'OK'
    ),
    '',
  ];

  const cl = model.clients;
  const clients = [
    '[ CLIENTS ]',
    line('REGISTERED', cl.registered == null ? 'NO DATA' : String(cl.registered), cl.registered == null ? 'NO_DATA' : 'OK'),
    line('ACTIVE', cl.active == null ? 'NO DATA' : String(cl.active), cl.active == null ? 'NO_DATA' : 'OK'),
    line('TRADING', cl.trading == null ? 'NO DATA' : String(cl.trading), cl.trading == null ? 'NO_DATA' : 'OK'),
    line('PAUSED', cl.paused == null ? 'NO DATA' : String(cl.paused), cl.paused == null ? 'NO_DATA' : 'OK'),
    line('DISABLED', cl.disabled == null ? 'NO DATA' : String(cl.disabled), cl.disabled == null ? 'NO_DATA' : 'OK'),
    '',
  ];

  const inc = model.incidents;
  const incidents = [
    '[ INCIDENTS ]',
    line('CRITICAL', String(inc.critical), inc.critical ? 'CRITICAL' : 'OK'),
    line('ERROR', String(inc.error), inc.error ? 'ERROR' : 'OK'),
    line('WARNING', String(inc.warning), inc.warning ? 'WARNING' : 'OK'),
    line('INFO', String(inc.info), 'OK'),
    '',
  ];

  const events = [
    '[ LIVE EVENT STREAM ]',
    ...(model.events.length
      ? model.events.slice(-12).map((e) => {
          const t = e.timestamp.slice(11, 19);
          return `${t} [${e.source}] ${e.type}${e.payload?.detail ? ` — ${e.payload.detail}` : ''}`;
        })
      : ['  (no events yet — NO DATA)']),
    '',
    'Trading Core runs independently of this TUI. Closing TUI does not stop trading.',
    green(''),
  ];

  return [...header, ...system, ...services, ...feedsBlock, ...capital, ...clients, ...incidents, ...events].join(
    '\n'
  );
}

/** Build service rows from readiness probes — status only from evidence. */
export function servicesFromProbes(probes: ProbeResult[]): CoreTuiModel['services'] {
  const names = [
    'SUPERVISOR',
    'DATABASE',
    'MARKET',
    'STRATEGY',
    'RISK',
    'EXECUTION',
    'RECONCILIATION',
    'CONTROL_API',
  ];
  return names.map((name) => {
    const p = probes.find((x) => x.name === name || x.name.startsWith(name));
    if (!p) return { name, status: 'NO_DATA', detail: 'probe missing' };
    return {
      name,
      status: p.status === 'OK' ? 'HEALTHY' : p.status,
      detail: p.detail.slice(0, 40),
    };
  });
}
