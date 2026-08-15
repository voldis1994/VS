/**
 * Durable device registry — public keys only. Private keys never stored here.
 */

import { createHash } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import {
  type DeviceType,
  type DeviceStatus,
  type ConnectionState,
  type VsRole,
  VS_WG_SERVER_IP,
  VS_WG_ADMIN_POOL_START,
  VS_WG_ADMIN_POOL_END,
  VS_WG_CLIENT_PREFIX,
  VS_WG_CLIENT_POOL_START,
  VS_WG_CLIENT_POOL_END,
  STALE_AFTER_MS,
  DISCONNECT_AFTER_MS,
} from './networkConstants.js';
import { fingerprintPublicKey } from './wireguardKeys.js';

export type DeviceRecord = {
  device_id: string;
  device_name: string;
  device_type: DeviceType;
  public_key: string;
  key_fingerprint: string;
  private_ip: string;
  client_id: number | null;
  account_id: number | null;
  role: VsRole;
  status: DeviceStatus;
  created_at: string;
  approved_at: string | null;
  last_seen: string | null;
  revoked_at: string | null;
  connection_state: ConnectionState;
  session_id: string | null;
  connected_at: string | null;
  latency_ms: number | null;
  /** App auth secret hash (not WireGuard private key) */
  device_token_hash: string | null;
};

type RegistryFile = {
  version: 1;
  server_id: string;
  server_public_key: string | null;
  server_private_ip: string;
  wg_listen_port: number;
  wg_interface: string;
  devices: DeviceRecord[];
  next_admin_ip: number;
  next_client_ip: number;
};

function nowIso(): string {
  return new Date().toISOString();
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class DeviceRegistry {
  private filePath: string;
  private data: RegistryFile;

  constructor(dataRoot: string, opts?: { serverId?: string; listenPort?: number; iface?: string }) {
    this.filePath = join(dataRoot, 'network', 'device-registry.json');
    if (existsSync(this.filePath)) {
      this.data = JSON.parse(readFileSync(this.filePath, 'utf8')) as RegistryFile;
    } else {
      this.data = {
        version: 1,
        server_id: opts?.serverId || 'VS-CORE-01',
        server_public_key: null,
        server_private_ip: VS_WG_SERVER_IP,
        wg_listen_port: opts?.listenPort || 51820,
        wg_interface: opts?.iface || 'vs0',
        devices: [],
        next_admin_ip: VS_WG_ADMIN_POOL_START,
        next_client_ip: VS_WG_CLIENT_POOL_START,
      };
      this.persist();
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.filePath);
  }

  getMeta(): Omit<RegistryFile, 'devices'> & { device_count: number } {
    const { devices, ...meta } = this.data;
    return { ...meta, device_count: devices.length };
  }

  list(): DeviceRecord[] {
    return this.data.devices.map((d) => ({ ...d }));
  }

  get(deviceId: string): DeviceRecord | undefined {
    return this.data.devices.find((d) => d.device_id === deviceId);
  }

  setServerPublicKey(publicKey: string): void {
    this.data.server_public_key = publicKey;
    this.persist();
  }

  private allocAdminIp(): string {
    for (let n = this.data.next_admin_ip; n <= VS_WG_ADMIN_POOL_END; n++) {
      const ip = `10.77.0.${n}`;
      if (!this.data.devices.some((d) => d.private_ip === ip)) {
        this.data.next_admin_ip = n + 1;
        return ip;
      }
    }
    throw new Error('ADMIN_IP_POOL_EXHAUSTED');
  }

  private allocClientIp(): string {
    for (let n = this.data.next_client_ip; n <= VS_WG_CLIENT_POOL_END; n++) {
      const ip = `${VS_WG_CLIENT_PREFIX}${n}`;
      if (!this.data.devices.some((d) => d.private_ip === ip)) {
        this.data.next_client_ip = n + 1;
        return ip;
      }
    }
    throw new Error('CLIENT_IP_POOL_EXHAUSTED');
  }

  registerPending(input: {
    device_id: string;
    device_name: string;
    device_type: 'ADMIN' | 'CLIENT';
    public_key: string;
    client_id?: number | null;
    account_id?: number | null;
    device_token: string;
  }): DeviceRecord {
    if (this.get(input.device_id)) throw new Error('DEVICE_ID_EXISTS');
    if (this.data.devices.some((d) => d.public_key === input.public_key)) {
      throw new Error('PUBLIC_KEY_EXISTS');
    }
    const private_ip =
      input.device_type === 'ADMIN' ? this.allocAdminIp() : this.allocClientIp();
    const rec: DeviceRecord = {
      device_id: input.device_id,
      device_name: input.device_name,
      device_type: input.device_type,
      public_key: input.public_key,
      key_fingerprint: fingerprintPublicKey(input.public_key),
      private_ip,
      client_id: input.client_id ?? null,
      account_id: input.account_id ?? null,
      role: input.device_type === 'ADMIN' ? 'OWNER_ADMIN' : 'CLIENT',
      status: 'PENDING_APPROVAL',
      created_at: nowIso(),
      approved_at: null,
      last_seen: null,
      revoked_at: null,
      connection_state: 'DISCONNECTED',
      session_id: null,
      connected_at: null,
      latency_ms: null,
      device_token_hash: hashToken(input.device_token),
    };
    this.data.devices.push(rec);
    this.persist();
    return { ...rec };
  }

  approve(deviceId: string): DeviceRecord {
    const d = this.get(deviceId);
    if (!d) throw new Error('DEVICE_NOT_FOUND');
    if (d.status === 'REVOKED') throw new Error('DEVICE_REVOKED');
    d.status = 'ACTIVE';
    d.approved_at = nowIso();
    this.persist();
    return { ...d };
  }

  revoke(deviceId: string): DeviceRecord {
    const d = this.get(deviceId);
    if (!d) throw new Error('DEVICE_NOT_FOUND');
    d.status = 'REVOKED';
    d.revoked_at = nowIso();
    d.connection_state = 'REVOKED';
    d.session_id = null;
    this.persist();
    return { ...d };
  }

  rotatePublicKey(deviceId: string, newPublicKey: string, newDeviceToken: string): DeviceRecord {
    const d = this.get(deviceId);
    if (!d) throw new Error('DEVICE_NOT_FOUND');
    if (d.status === 'REVOKED') throw new Error('DEVICE_REVOKED');
    if (this.data.devices.some((x) => x.public_key === newPublicKey && x.device_id !== deviceId)) {
      throw new Error('PUBLIC_KEY_EXISTS');
    }
    d.public_key = newPublicKey;
    d.key_fingerprint = fingerprintPublicKey(newPublicKey);
    d.device_token_hash = hashToken(newDeviceToken);
    d.session_id = null;
    d.connection_state = 'DISCONNECTED';
    this.persist();
    return { ...d };
  }

  verifyDeviceToken(deviceId: string, token: string): boolean {
    const d = this.get(deviceId);
    if (!d || d.status !== 'ACTIVE') return false;
    if (!d.device_token_hash) return false;
    return d.device_token_hash === hashToken(token);
  }

  heartbeat(
    deviceId: string,
    opts?: { session_id?: string; latency_ms?: number | null }
  ): DeviceRecord {
    const d = this.get(deviceId);
    if (!d) throw new Error('DEVICE_NOT_FOUND');
    if (d.status === 'REVOKED') {
      d.connection_state = 'REVOKED';
      this.persist();
      throw new Error('DEVICE_REVOKED');
    }
    if (d.status !== 'ACTIVE') throw new Error('DEVICE_NOT_ACTIVE');
    const t = nowIso();
    d.last_seen = t;
    if (!d.connected_at) d.connected_at = t;
    d.connection_state = 'CONNECTED';
    if (opts?.session_id) d.session_id = opts.session_id;
    if (opts?.latency_ms != null) d.latency_ms = opts.latency_ms;
    this.persist();
    return { ...d };
  }

  /** Recompute CONNECTED/STALE/DISCONNECTED from last_seen. */
  refreshConnectionStates(nowMs = Date.now()): void {
    let changed = false;
    for (const d of this.data.devices) {
      if (d.status === 'REVOKED') {
        if (d.connection_state !== 'REVOKED') {
          d.connection_state = 'REVOKED';
          changed = true;
        }
        continue;
      }
      if (!d.last_seen) {
        if (d.connection_state !== 'DISCONNECTED') {
          d.connection_state = 'DISCONNECTED';
          changed = true;
        }
        continue;
      }
      const age = nowMs - Date.parse(d.last_seen);
      let next: ConnectionState = 'CONNECTED';
      if (age > DISCONNECT_AFTER_MS) next = 'DISCONNECTED';
      else if (age > STALE_AFTER_MS) next = 'STALE';
      if (d.connection_state !== next) {
        d.connection_state = next;
        if (next === 'DISCONNECTED') {
          d.connected_at = null;
          d.session_id = null;
        }
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  counts(): {
    active: number;
    connected: number;
    stale: number;
    revoked: number;
    pending: number;
  } {
    this.refreshConnectionStates();
    const devices = this.data.devices;
    return {
      active: devices.filter((d) => d.status === 'ACTIVE').length,
      connected: devices.filter((d) => d.connection_state === 'CONNECTED').length,
      stale: devices.filter((d) => d.connection_state === 'STALE').length,
      revoked: devices.filter((d) => d.status === 'REVOKED').length,
      pending: devices.filter((d) => d.status === 'PENDING_APPROVAL').length,
    };
  }

  /** Public wireguard peer list for ACTIVE devices (no private keys). */
  activePeers(): Array<{ public_key: string; private_ip: string; device_id: string }> {
    return this.data.devices
      .filter((d) => d.status === 'ACTIVE')
      .map((d) => ({
        public_key: d.public_key,
        private_ip: d.private_ip,
        device_id: d.device_id,
      }));
  }
}

let shared: DeviceRegistry | null = null;

export function getDeviceRegistry(dataRoot?: string): DeviceRegistry {
  if (!shared) {
    const root =
      dataRoot ||
      process.env.VS_SERVER_DATA ||
      process.env.VS_CORE_DATA ||
      join(process.cwd(), 'data', 'vs-server');
    shared = new DeviceRegistry(root);
  }
  return shared;
}

export function resetDeviceRegistryForTests(dataRoot: string): DeviceRegistry {
  shared = new DeviceRegistry(dataRoot, { serverId: 'VS-CORE-01' });
  return shared;
}
