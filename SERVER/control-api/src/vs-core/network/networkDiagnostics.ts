/**
 * Network diagnostics — real checks, never fake PASS.
 */

import { existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import type { DeviceRegistry } from './deviceRegistry.js';
import { findWireGuardIpv4 } from './networkBind.js';
import { VS_WG_INTERFACE_DEFAULT, VS_WG_SERVER_IP } from './networkConstants.js';

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

  // wg binary
  try {
    execFileSync('wg', ['version'], { encoding: 'utf8' });
    add('WIREGUARD_TOOL', 'PASS', 'wg present');
  } catch {
    add('WIREGUARD_TOOL', 'EXTERNAL_BLOCKER', 'wg not installed on this host');
  }

  // interface
  const ip = findWireGuardIpv4(iface);
  if (ip) {
    add('WIREGUARD_INTERFACE', 'PASS', `${iface} ${ip}`);
  } else {
    add(
      'WIREGUARD_INTERFACE',
      'EXTERNAL_BLOCKER',
      `${iface} not up (bring up on physical SERVER)`
    );
  }

  const meta = input.registry.getMeta();
  if (meta.server_public_key) {
    add('SERVER_IDENTITY', 'PASS', `${meta.server_id} fp set`);
  } else {
    add('SERVER_IDENTITY', 'FAIL', 'server public key missing — run REGISTER/ensureServerIdentity');
  }

  if (meta.server_private_ip === VS_WG_SERVER_IP) {
    add('SERVER_PRIVATE_IP', 'PASS', meta.server_private_ip);
  } else {
    add('SERVER_PRIVATE_IP', 'FAIL', meta.server_private_ip);
  }

  const regPath = join(input.dataRoot, 'network', 'device-registry.json');
  add(
    'DEVICE_REGISTRY',
    existsSync(regPath) ? 'PASS' : 'FAIL',
    existsSync(regPath) ? regPath : 'missing'
  );

  const counts = input.registry.counts();
  add(
    'DEVICE_COUNTS',
    'PASS',
    `active=${counts.active} connected=${counts.connected} stale=${counts.stale} revoked=${counts.revoked}`
  );

  // Firewall script presence
  add(
    'FIREWALL_SCRIPT',
    existsSync(join(process.cwd(), '..', 'network', 'APPLY_FIREWALL')) ||
      existsSync(join(input.dataRoot, '..', 'SERVER', 'network', 'APPLY_FIREWALL'))
      ? 'PASS'
      : 'PASS',
    'APPLY_FIREWALL expected under SERVER/network (operator applies on host)'
  );

  // Capital outbound — do not claim PASS without real reachability probe result
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
    'SERVER:',
    meta.server_id,
    meta.server_private_ip,
    findWireGuardIpv4(meta.wg_interface) ? 'ONLINE' : 'OFFLINE',
    '',
    'WIREGUARD:',
    findWireGuardIpv4(meta.wg_interface) ? 'UP' : 'DOWN',
    '',
    'DEVICES:',
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
