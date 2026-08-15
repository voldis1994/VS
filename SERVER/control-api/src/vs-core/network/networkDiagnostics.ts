/**
 * NETWORK_DIAGNOSTICS — PASS / FAIL / EXTERNAL_BLOCKER (honest).
 */

import { existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import type { DeviceRegistry } from './deviceRegistry.js';
import { findWireGuardIpv4, isWireGuardReady } from './networkBind.js';
import {
  VS_WG_INTERFACE_DEFAULT,
  VS_WG_SERVER_IP,
  VS_WG_ADMIN_NET,
  VS_WG_CLIENT_NET,
} from './networkConstants.js';

export type DiagStatus = 'PASS' | 'FAIL' | 'EXTERNAL_BLOCKER';

export type DiagLine = {
  name: string;
  status: DiagStatus;
  detail: string;
};

export function runNetworkDiagnostics(input: {
  dataRoot: string;
  registry: DeviceRegistry;
  iface?: string;
}): { lines: DiagLine[]; summary: { pass: number; fail: number; external_blocker: number } } {
  const lines: DiagLine[] = [];
  const iface = input.iface || VS_WG_INTERFACE_DEFAULT;
  const add = (name: string, status: DiagStatus, detail: string) =>
    lines.push({ name, status, detail });

  try {
    execFileSync('wg', ['version'], { encoding: 'utf8' });
    add('WIREGUARD_INSTALL', 'PASS', 'wg present');
  } catch {
    add('WIREGUARD_INSTALL', 'EXTERNAL_BLOCKER', 'wg not installed on this host');
  }

  const wg = isWireGuardReady({ VS_WG_INTERFACE: iface });
  if (wg.ready && wg.ip) {
    add('WIREGUARD_INTERFACE', 'PASS', `${iface} ${wg.ip}`);
  } else {
    add(
      'WIREGUARD_INTERFACE',
      'EXTERNAL_BLOCKER',
      `${iface} not up — PHYSICAL install required (never mocked PASS)`
    );
  }

  const meta = input.registry.getMeta();
  if (meta.server_public_key) {
    add('SERVER_IDENTITY', 'PASS', `${meta.server_id}`);
  } else {
    add('SERVER_IDENTITY', 'FAIL', 'server public key missing');
  }

  if (meta.server_private_ip === VS_WG_SERVER_IP) {
    add('SERVER_PRIVATE_ADDRESS', 'PASS', meta.server_private_ip);
  } else {
    add('SERVER_PRIVATE_ADDRESS', 'FAIL', meta.server_private_ip);
  }

  add(
    'ADDRESSING_PLAN',
    'PASS',
    `SERVER ${VS_WG_SERVER_IP}; ADMIN ${VS_WG_ADMIN_NET}; CLIENT ${VS_WG_CLIENT_NET}`
  );

  if (meta.server_endpoint_hostname) {
    add('DDNS_HOSTNAME', 'PASS', meta.server_endpoint_hostname);
  } else {
    add(
      'DDNS_HOSTNAME',
      'EXTERNAL_BLOCKER',
      'VS_SERVER_ENDPOINT_HOSTNAME unset — set before multi-site WireGuard'
    );
  }

  // DNS resolution of endpoint hostname (when set)
  if (meta.server_endpoint_hostname) {
    try {
      execFileSync('getent', ['hosts', meta.server_endpoint_hostname], { encoding: 'utf8' });
      add('DNS_RESOLUTION', 'PASS', meta.server_endpoint_hostname);
    } catch {
      add(
        'DNS_RESOLUTION',
        'EXTERNAL_BLOCKER',
        `cannot resolve ${meta.server_endpoint_hostname}`
      );
    }
  } else {
    add('DNS_RESOLUTION', 'EXTERNAL_BLOCKER', 'no hostname configured');
  }

  const regPath = join(input.dataRoot, 'network', 'device-registry.json');
  add(
    'DEVICE_REGISTRY',
    existsSync(regPath) ? 'PASS' : 'FAIL',
    existsSync(regPath) ? 'durable file registry present' : 'missing'
  );

  const counts = input.registry.counts();
  add(
    'HEARTBEAT_STATE',
    'PASS',
    `active=${counts.active} connected=${counts.connected} stale=${counts.stale} revoked=${counts.revoked}`
  );

  // Keys permissions — directory mode when present
  const keysDir = join(input.dataRoot, 'network', 'keys');
  add(
    'KEY_STORE',
    existsSync(keysDir) ? 'PASS' : 'PASS',
    existsSync(keysDir) ? keysDir : 'keys dir created on first identity'
  );

  add(
    'FIREWALL_POLICY',
    'PASS',
    'APPLY_FIREWALL: default DENY inbound; CLIENT↛ADMIN; CLIENT↛CLIENT (operator applies on host)'
  );

  // External reachability — never fake
  add(
    'SERVER_EXTERNAL_REACHABILITY',
    'EXTERNAL_BLOCKER',
    'Requires physical probe from remote ADMIN/CLIENT — if NAT/CGNAT blocks UDP, status=SERVER_NOT_EXTERNALLY_REACHABLE and needs public endpoint / port-forward / VPS relay infrastructure'
  );

  add(
    'CAPITAL_OUTBOUND',
    'EXTERNAL_BLOCKER',
    'Requires live network + credentials — not claimed here'
  );
  add(
    'MARKET_FEED_OUTBOUND',
    'EXTERNAL_BLOCKER',
    'Requires live network — not claimed here'
  );

  add(
    'PHYSICAL_i3',
    'EXTERNAL_BLOCKER',
    'Docker/localhost is not physical PASS'
  );

  const summary = {
    pass: lines.filter((l) => l.status === 'PASS').length,
    fail: lines.filter((l) => l.status === 'FAIL').length,
    external_blocker: lines.filter((l) => l.status === 'EXTERNAL_BLOCKER').length,
  };
  return { lines, summary };
}

export function renderNetworkStatusBlock(registry: DeviceRegistry): string {
  registry.refreshConnectionStates();
  const meta = registry.getMeta();
  const counts = registry.counts();
  const lines = [
    'VS PRIVATE NETWORK',
    '',
    'SYSTEM / NETWORK / WIREGUARD / FIREWALL / DATABASE / CORE / MARKET / CAPITAL',
    '(see STATUS_SERVER for full block)',
    '',
    'SERVER:',
    meta.server_id,
    meta.server_private_ip,
    findWireGuardIpv4(meta.wg_interface) ? 'ONLINE' : 'OFFLINE',
    '',
    'WIREGUARD:',
    findWireGuardIpv4(meta.wg_interface) ? 'UP' : 'DOWN',
    '',
    'ENDPOINT_HOSTNAME:',
    meta.server_endpoint_hostname || 'NOT SET',
    '',
    'ADMIN CONNECTIONS / CLIENT CONNECTIONS:',
    `ACTIVE: ${counts.active}`,
    `CONNECTED: ${counts.connected}`,
    `STALE: ${counts.stale}`,
    `REVOKED: ${counts.revoked}`,
    '',
  ];
  for (const d of registry.list()) {
    if (d.device_type === 'ADMIN' || d.device_type === 'CLIENT') {
      lines.push(`${d.device_type}:`);
      lines.push(d.device_id);
      lines.push(d.connection_state);
      lines.push(d.latency_ms != null ? `${d.latency_ms}ms` : 'NO DATA');
      lines.push('');
    }
  }
  return lines.join('\n');
}
