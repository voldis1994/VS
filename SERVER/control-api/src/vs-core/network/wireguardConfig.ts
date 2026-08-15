/**
 * WireGuard config rendering — private keys injected only at write-to-data-dir time.
 */

import type { DeviceRegistry } from './deviceRegistry.js';
import { VS_WG_SUBNET, VS_WG_SERVER_IP } from './networkConstants.js';

export function renderServerWgConf(input: {
  privateKeyPlaceholder?: string; // never commit real key — caller substitutes
  listenPort: number;
  peers: Array<{ public_key: string; private_ip: string; device_id: string }>;
}): string {
  const lines = [
    '# VS SERVER WireGuard — generated; private key from data store only',
    '[Interface]',
    `Address = ${VS_WG_SERVER_IP}/16`,
    `ListenPort = ${input.listenPort}`,
    `PrivateKey = ${input.privateKeyPlaceholder || '<SERVER_PRIVATE_KEY>'}`,
    '',
  ];
  for (const p of input.peers) {
    lines.push(`# peer ${p.device_id}`);
    lines.push('[Peer]');
    lines.push(`PublicKey = ${p.public_key}`);
    lines.push(`AllowedIPs = ${p.private_ip}/32`);
    lines.push('');
  }
  return lines.join('\n');
}

export function renderPeerWgConf(input: {
  devicePrivateKeyPlaceholder: string;
  devicePrivateIp: string;
  serverPublicKey: string;
  serverEndpoint: string; // host:port public UDP endpoint for WG transport
  persistentKeepalive?: number;
}): string {
  return [
    '# VS peer config — private key never committed to git',
    '[Interface]',
    `Address = ${input.devicePrivateIp}/32`,
    `PrivateKey = ${input.devicePrivateKeyPlaceholder}`,
    '',
    '[Peer]',
    `PublicKey = ${input.serverPublicKey}`,
    `Endpoint = ${input.serverEndpoint}`,
    `AllowedIPs = ${VS_WG_SUBNET}`,
    `PersistentKeepalive = ${input.persistentKeepalive ?? 25}`,
    '',
  ].join('\n');
}

export function buildServerConfFromRegistry(
  registry: DeviceRegistry,
  serverPrivateKeyPlaceholder = '<SERVER_PRIVATE_KEY>'
): string {
  const meta = registry.getMeta();
  return renderServerWgConf({
    privateKeyPlaceholder: serverPrivateKeyPlaceholder,
    listenPort: meta.wg_listen_port,
    peers: registry.activePeers(),
  });
}
