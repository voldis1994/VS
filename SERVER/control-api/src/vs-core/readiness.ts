/**
 * Boot readiness — no fake READY. Evidence-based probes only.
 */

export type ProbeStatus = 'OK' | 'WARNING' | 'ERROR' | 'CRITICAL' | 'UNKNOWN';

export type ProbeResult = {
  name: string;
  status: ProbeStatus;
  reason_code: string | null;
  detail: string;
  checked_at: string;
};

export type ReadyState = 'READY' | 'DEGRADED' | 'NOT_READY' | 'BOOTING';

export type ReadinessReport = {
  state: ReadyState;
  reason_code: string | null;
  probes: ProbeResult[];
  live_ready: boolean;
  live_blockers: string[];
};

const REQUIRED_FOR_READY = [
  'NETWORK',
  'TIME',
  'STORAGE',
  'DATABASE',
  'MARKET',
  'CAPITAL',
  'STRATEGY',
  'RISK',
  'EXECUTION',
  'RECONCILIATION',
] as const;

export type ProbeName = (typeof REQUIRED_FOR_READY)[number] | 'CONTROL_API' | 'UPDATER';

export function evaluateReadiness(probes: ProbeResult[]): ReadinessReport {
  const byName = new Map(probes.map((p) => [p.name, p]));
  const missing: string[] = [];
  const bad: ProbeResult[] = [];

  for (const name of REQUIRED_FOR_READY) {
    const p = byName.get(name);
    if (!p) {
      missing.push(name);
      continue;
    }
    if (p.status === 'UNKNOWN') {
      bad.push(p);
      continue;
    }
    if (p.status === 'ERROR' || p.status === 'CRITICAL') {
      bad.push(p);
    }
  }

  if (missing.length) {
    return {
      state: 'NOT_READY',
      reason_code: `PROBE_MISSING_${missing[0]}`,
      probes,
      live_ready: false,
      live_blockers: missing.map((m) => `missing probe ${m}`),
    };
  }

  if (bad.length) {
    const worst = bad.find((b) => b.status === 'CRITICAL') || bad[0]!;
    return {
      state: 'NOT_READY',
      reason_code: worst.reason_code || `${worst.name}_${worst.status}`,
      probes,
      live_ready: false,
      live_blockers: bad.map((b) => b.reason_code || b.detail),
    };
  }

  const warnings = probes.filter((p) => p.status === 'WARNING');
  const liveBlockers: string[] = [];
  for (const name of REQUIRED_FOR_READY) {
    const p = byName.get(name)!;
    if (p.status !== 'OK') liveBlockers.push(`${name} not OK`);
  }
  // LIVE READY requires all OK + no unresolved critical (warnings block LIVE, not boot READY)
  const live_ready = liveBlockers.length === 0 && warnings.length === 0;

  if (warnings.length) {
    return {
      state: 'DEGRADED',
      reason_code: warnings[0]!.reason_code || 'DEGRADED',
      probes,
      live_ready: false,
      live_blockers: warnings.map((w) => w.reason_code || w.detail),
    };
  }

  return {
    state: 'READY',
    reason_code: null,
    probes,
    live_ready,
    live_blockers: live_ready ? [] : liveBlockers,
  };
}

export function probe(
  name: string,
  status: ProbeStatus,
  detail: string,
  reason_code: string | null = null
): ProbeResult {
  return {
    name,
    status,
    reason_code: status === 'OK' ? null : reason_code || `${name}_${status}`,
    detail,
    checked_at: new Date().toISOString(),
  };
}

/** Render local VS Terminal status block (no full desktop). */
export function renderTerminalScreen(report: ReadinessReport, extras: {
  cpu?: string;
  ram?: string;
  ssd?: string;
  temperature?: string;
  uptime?: string;
  network_latency?: string;
  vs_version?: string;
  strategy_version?: string;
  last_update?: string;
}): string {
  const line = (name: string) => {
    const p = report.probes.find((x) => x.name === name);
    const st = p?.status ?? 'UNKNOWN';
    const pad = name.padEnd(16, '.');
    return `${pad} ${st}${p?.reason_code ? ` (${p.reason_code})` : ''}`;
  };
  const names = [
    'SYSTEM',
    'NETWORK',
    'STORAGE',
    'DATABASE',
    'TIME',
    'CAPITAL',
    'MARKET',
    'STRATEGY',
    'RISK',
    'EXECUTION',
    'POSITIONS',
    'CONTROL_API',
    'MOBILE_CLIENTS',
    'UPDATER',
  ];
  // Map TIME probe name
  const mapped = names.map((n) => {
    if (n === 'SYSTEM') {
      return `SYSTEM.......... ${report.state}${report.reason_code ? ` · ${report.reason_code}` : ''}`;
    }
    if (n === 'TIME') return line('TIME');
    if (n === 'CAPITAL') return line('CAPITAL');
    if (n === 'POSITIONS') return line('RECONCILIATION');
    if (n === 'MOBILE_CLIENTS') {
      const p = report.probes.find((x) => x.name === 'CONTROL_API');
      return `MOBILE CLIENTS.. ${p?.status === 'OK' ? 'OK' : p?.status || 'UNKNOWN'}`;
    }
    return line(n === 'TIME' ? 'TIME' : n);
  });

  return [
    'VS CORE',
    '',
    ...mapped,
    '',
    `STATE: ${report.state}`,
    report.live_ready ? 'LIVE READY: YES' : `LIVE READY: NO${report.live_blockers[0] ? ` · ${report.live_blockers[0]}` : ''}`,
    '',
    `CPU ${extras.cpu ?? 'n/a'}  RAM ${extras.ram ?? 'n/a'}  SSD ${extras.ssd ?? 'n/a'}`,
    `temp ${extras.temperature ?? 'n/a'}  uptime ${extras.uptime ?? 'n/a'}  latency ${extras.network_latency ?? 'n/a'}`,
    `VS ${extras.vs_version ?? 'n/a'}  strategy ${extras.strategy_version ?? 'n/a'}  updated ${extras.last_update ?? 'n/a'}`,
  ].join('\n');
}
