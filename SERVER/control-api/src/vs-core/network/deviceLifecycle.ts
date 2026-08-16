/**
 * Device registration helpers — bootstrap + enrollment-aware lifecycle.
 * Prefer enrollment.ts for product path (keys generated on device).
 * Private keys written only under dataRoot/network/keys (outside git) when SERVER generates for bootstrap.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { DeviceRegistry } from './deviceRegistry.js';
import {
  generateWgKeyPair,
  writePrivateKeyFile,
  randomDeviceToken,
  assertPathOutsideRepo,
} from './wireguardKeys.js';
import { renderPeerWgConf, buildServerConfFromRegistry, serverWgEndpoint } from './wireguardConfig.js';
import { invalidateDeviceSessions } from './deviceAuth.js';
import { nextAdminId, nextClientId } from './enrollment.js';
import { appendNetworkAudit } from './networkAudit.js';

export function registerAdminDevice(
  registry: DeviceRegistry,
  dataRoot: string,
  input?: { device_name?: string; device_id?: string; auto_approve?: boolean }
): {
  device_id: string;
  private_ip: string;
  private_address: string;
  public_key: string;
  device_token: string;
  peer_config_path: string;
  private_key_once: string;
} {
  assertPathOutsideRepo(dataRoot);
  const pair = generateWgKeyPair();
  const device_token = randomDeviceToken();
  const device_id = input?.device_id || nextAdminId(registry);
  const device_name = input?.device_name || device_id;
  const rec = registry.registerPending({
    device_id,
    device_name,
    device_type: 'ADMIN',
    public_key: pair.publicKey,
    device_token,
  });
  if (input?.auto_approve !== false) {
    registry.approve(device_id);
  }
  const issuedDir = join(dataRoot, 'network', 'issued');
  mkdirSync(issuedDir, { recursive: true });
  writePrivateKeyFile(dataRoot, device_id, pair.privateKey);
  const meta = registry.getMeta();
  const conf = renderPeerWgConf({
    devicePrivateKeyPlaceholder: pair.privateKey,
    devicePrivateIp: rec.private_address,
    serverPublicKey: meta.server_public_key || '<SERVER_PUBLIC_KEY>',
    serverEndpoint: serverWgEndpoint(meta.server_endpoint_hostname, meta.wg_listen_port),
  });
  const peer_config_path = join(issuedDir, `${device_id}.conf`);
  writeFileSync(peer_config_path, conf, { mode: 0o600 });
  appendNetworkAudit(dataRoot, {
    action: 'DEVICE_CREATED',
    actor: 'SERVER',
    device_id,
    result: 'OK',
    detail: { device_type: 'ADMIN', private_address: rec.private_address },
  });
  return {
    device_id,
    private_ip: rec.private_address,
    private_address: rec.private_address,
    public_key: pair.publicKey,
    device_token,
    peer_config_path,
    private_key_once: pair.privateKey,
  };
}

export function registerClientDevice(
  registry: DeviceRegistry,
  dataRoot: string,
  input: {
    client_id: number;
    account_id?: number | null;
    device_name?: string;
    device_id?: string;
    auto_approve?: boolean;
  }
): {
  device_id: string;
  private_ip: string;
  private_address: string;
  public_key: string;
  device_token: string;
  peer_config_path: string;
  private_key_once: string;
  client_id: number;
} {
  assertPathOutsideRepo(dataRoot);
  const pair = generateWgKeyPair();
  const device_token = randomDeviceToken();
  const device_id = input.device_id || nextClientId(registry);
  const rec = registry.registerPending({
    device_id,
    device_name: input.device_name || device_id,
    device_type: 'CLIENT',
    public_key: pair.publicKey,
    client_id: input.client_id,
    account_id: input.account_id ?? null,
    device_token,
  });
  if (input.auto_approve !== false) {
    registry.approve(device_id);
  }
  const issuedDir = join(dataRoot, 'network', 'issued');
  mkdirSync(issuedDir, { recursive: true });
  writePrivateKeyFile(dataRoot, device_id, pair.privateKey);
  const meta = registry.getMeta();
  const conf = renderPeerWgConf({
    devicePrivateKeyPlaceholder: pair.privateKey,
    devicePrivateIp: rec.private_address,
    serverPublicKey: meta.server_public_key || '<SERVER_PUBLIC_KEY>',
    serverEndpoint: serverWgEndpoint(meta.server_endpoint_hostname, meta.wg_listen_port),
  });
  const peer_config_path = join(issuedDir, `${device_id}.conf`);
  writeFileSync(peer_config_path, conf, { mode: 0o600 });
  appendNetworkAudit(dataRoot, {
    action: 'DEVICE_CREATED',
    actor: 'SERVER',
    device_id,
    result: 'OK',
    detail: { device_type: 'CLIENT', client_id: input.client_id },
  });
  return {
    device_id,
    private_ip: rec.private_address,
    private_address: rec.private_address,
    public_key: pair.publicKey,
    device_token,
    peer_config_path,
    private_key_once: pair.privateKey,
    client_id: input.client_id,
  };
}

export function revokeDevice(registry: DeviceRegistry, deviceId: string, dataRoot?: string): void {
  registry.revoke(deviceId);
  invalidateDeviceSessions(deviceId);
  if (dataRoot) {
    appendNetworkAudit(dataRoot, {
      action: 'DEVICE_REVOKED',
      actor: 'ADMIN',
      device_id: deviceId,
      result: 'OK',
    });
  }
}

export function rotateDeviceKey(
  registry: DeviceRegistry,
  dataRoot: string,
  deviceId: string
): { public_key: string; device_token: string; private_key_once: string; peer_config_path: string; key_version: number } {
  assertPathOutsideRepo(dataRoot);
  const existing = registry.get(deviceId);
  if (!existing) throw new Error('DEVICE_NOT_FOUND');
  const pair = generateWgKeyPair();
  const device_token = randomDeviceToken();
  const updated = registry.rotatePublicKey(deviceId, pair.publicKey, device_token);
  invalidateDeviceSessions(deviceId);
  writePrivateKeyFile(dataRoot, deviceId, pair.privateKey);
  const meta = registry.getMeta();
  const conf = renderPeerWgConf({
    devicePrivateKeyPlaceholder: pair.privateKey,
    devicePrivateIp: existing.private_address || existing.private_ip,
    serverPublicKey: meta.server_public_key || '<SERVER_PUBLIC_KEY>',
    serverEndpoint: serverWgEndpoint(meta.server_endpoint_hostname, meta.wg_listen_port),
  });
  const peer_config_path = join(dataRoot, 'network', 'issued', `${deviceId}.conf`);
  mkdirSync(join(dataRoot, 'network', 'issued'), { recursive: true });
  writeFileSync(peer_config_path, conf, { mode: 0o600 });
  appendNetworkAudit(dataRoot, {
    action: 'KEY_ROTATED',
    actor: 'ADMIN',
    device_id: deviceId,
    result: 'OK',
    detail: { key_version: updated.key_version },
  });
  return {
    public_key: pair.publicKey,
    device_token,
    private_key_once: pair.privateKey,
    peer_config_path,
    key_version: updated.key_version,
  };
}

/**
 * Preferred product rotation: device supplies new public key; SERVER never sees private key.
 */
export function rotateDevicePublicKeyOnServer(
  registry: DeviceRegistry,
  dataRoot: string,
  deviceId: string,
  newPublicKey: string
): { device_token: string; key_version: number } {
  const device_token = randomDeviceToken();
  const updated = registry.rotatePublicKey(deviceId, newPublicKey, device_token);
  invalidateDeviceSessions(deviceId);
  appendNetworkAudit(dataRoot, {
    action: 'KEY_ROTATED',
    actor: 'DEVICE',
    device_id: deviceId,
    result: 'OK',
    detail: { key_version: updated.key_version, on_device: true },
  });
  return { device_token, key_version: updated.key_version };
}

export function ensureServerIdentity(
  registry: DeviceRegistry,
  dataRoot: string
): { public_key: string; server_id: string } {
  assertPathOutsideRepo(dataRoot);
  const meta = registry.getMeta();
  if (meta.server_public_key) {
    return { public_key: meta.server_public_key, server_id: meta.server_id };
  }
  const pair = generateWgKeyPair();
  writePrivateKeyFile(dataRoot, meta.server_id, pair.privateKey);
  registry.setServerPublicKey(pair.publicKey);
  const conf = buildServerConfFromRegistry(registry);
  mkdirSync(join(dataRoot, 'network'), { recursive: true });
  writeFileSync(join(dataRoot, 'network', 'server.wg.conf.template'), conf);
  return { public_key: pair.publicKey, server_id: meta.server_id };
}
