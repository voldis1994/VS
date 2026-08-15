/**
 * Durable device registry — public keys only. Private keys never stored here.
 * File-backed (persistent) authority; Postgres migration mirrors production schema.
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
  VS_WG_CLIENT_POOL_START,
  VS_WG_CLIENT_POOL_END,
  VS_DEFAULT_SERVER_ID,
  STALE_AFTER_MS,
  DISCONNECT_AFTER_MS,
  adminHostIndexToIp,
  clientHostIndexToIp,
} from './networkConstants.js';
import { fingerprintPublicKey } from './wireguardKeys.js';
import {
  permissionsForRole,
  type Permission,
} from './permissions.js';

export type DeviceRecord = {
  device_id: string;
  device_name: string;
  device_type: DeviceType;
  public_key: string;
  key_fingerprint: string;
  private_address: string;
  /** @deprecated alias of private_address for Phase-1 callers */
  private_ip: string;
  client_id: number | null;
  account_id: number | null;
  owner_scope: string | null;
  role: VsRole;
  permissions: Permission[];
  status: DeviceStatus;
  created_at: string;
  approved_at: string | null;
  last_seen: string | null;
  revoked_at: string | null;
  key_version: number;
  connection_state: ConnectionState;
  session_id: string | null;
  connected_at: string | null;
  latency_ms: number | null;
  /** App auth secret hash (not WireGuard private key) */
  device_token_hash: string | null;
};

type EnrollmentRecord = {
  token_hash: string;
  enrollment_id: string;
  device_type: 'ADMIN' | 'CLIENT';
  device_id: string | null;
  client_id: number | null;
  account_id: number | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
  created_by: string;
};

type RegistryFile = {
  version: 2;
  server_id: string;
  server_public_key: string | null;
  server_private_ip: string;
  /** DDNS / public hostname foundation — never hardcode only raw public IP */
  server_endpoint_hostname: string | null;
  wg_listen_port: number;
  wg_interface: string;
  devices: DeviceRecord[];
  enrollments: EnrollmentRecord[];
  next_admin_ip: number;
  next_client_ip: number;
  /** command_id → result for state-changing dedupe */
  command_dedupe: Record<string, { result: unknown; at: string; device_id: string }>;
};

function nowIso(): string {
  return new Date().toISOString();
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function normalizeDevice(d: DeviceRecord & { private_ip?: string }): DeviceRecord {
  const addr = d.private_address || d.private_ip || '';
  return {
    ...d,
    private_address: addr,
    private_ip: addr,
    permissions: d.permissions?.length ? d.permissions : [...permissionsForRole(d.role)],
    key_version: d.key_version ?? 1,
    owner_scope: d.owner_scope ?? (d.client_id != null ? `client:${d.client_id}` : null),
  };
}

export class DeviceRegistry {
  private filePath: string;
  private data: RegistryFile;

  constructor(dataRoot: string, opts?: { serverId?: string; listenPort?: number; iface?: string }) {
    this.filePath = join(dataRoot, 'network', 'device-registry.json');
    if (existsSync(this.filePath)) {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as RegistryFile & {
        version?: number;
        enrollments?: EnrollmentRecord[];
        command_dedupe?: RegistryFile['command_dedupe'];
        server_endpoint_hostname?: string | null;
      };
      this.data = {
        version: 2,
        server_id: raw.server_id || opts?.serverId || VS_DEFAULT_SERVER_ID,
        server_public_key: raw.server_public_key,
        server_private_ip: raw.server_private_ip || VS_WG_SERVER_IP,
        server_endpoint_hostname: raw.server_endpoint_hostname ?? null,
        wg_listen_port: raw.wg_listen_port || opts?.listenPort || 51820,
        wg_interface: raw.wg_interface || opts?.iface || 'vs0',
        devices: (raw.devices || []).map((d) => normalizeDevice(d as DeviceRecord)),
        enrollments: raw.enrollments || [],
        next_admin_ip: raw.next_admin_ip ?? VS_WG_ADMIN_POOL_START,
        next_client_ip: raw.next_client_ip ?? VS_WG_CLIENT_POOL_START,
        command_dedupe: raw.command_dedupe || {},
      };
      // Migrate legacy 10.77.0.x admin addresses only when empty registry — leave existing physical installs
      this.persist();
    } else {
      this.data = {
        version: 2,
        server_id: opts?.serverId || VS_DEFAULT_SERVER_ID,
        server_public_key: null,
        server_private_ip: VS_WG_SERVER_IP,
        server_endpoint_hostname: process.env.VS_SERVER_ENDPOINT_HOSTNAME || null,
        wg_listen_port: opts?.listenPort || 51820,
        wg_interface: opts?.iface || 'vs0',
        devices: [],
        enrollments: [],
        next_admin_ip: VS_WG_ADMIN_POOL_START,
        next_client_ip: VS_WG_CLIENT_POOL_START,
        command_dedupe: {},
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

  getMeta(): Omit<RegistryFile, 'devices' | 'enrollments' | 'command_dedupe'> & {
    device_count: number;
  } {
    const { devices, enrollments, command_dedupe, ...meta } = this.data;
    void enrollments;
    void command_dedupe;
    return { ...meta, device_count: devices.length };
  }

  setEndpointHostname(hostname: string | null): void {
    this.data.server_endpoint_hostname = hostname;
    this.persist();
  }

  list(): DeviceRecord[] {
    return this.data.devices.map((d) => ({ ...d }));
  }

  get(deviceId: string): DeviceRecord | undefined {
    const d = this.data.devices.find((x) => x.device_id === deviceId);
    return d ? { ...d } : undefined;
  }

  setServerPublicKey(publicKey: string): void {
    this.data.server_public_key = publicKey;
    this.persist();
  }

  private allocAdminIp(): string {
    for (let n = this.data.next_admin_ip; n <= VS_WG_ADMIN_POOL_END; n++) {
      const ip = adminHostIndexToIp(n);
      if (!this.data.devices.some((d) => d.private_address === ip || d.private_ip === ip)) {
        this.data.next_admin_ip = n + 1;
        return ip;
      }
    }
    throw new Error('ADMIN_IP_POOL_EXHAUSTED');
  }

  private allocClientIp(): string {
    for (let n = this.data.next_client_ip; n <= VS_WG_CLIENT_POOL_END; n++) {
      const ip = clientHostIndexToIp(n);
      if (!this.data.devices.some((d) => d.private_address === ip || d.private_ip === ip)) {
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
    owner_scope?: string | null;
  }): DeviceRecord {
    if (this.get(input.device_id)) throw new Error('DEVICE_ID_EXISTS');
    if (this.data.devices.some((d) => d.public_key === input.public_key)) {
      throw new Error('PUBLIC_KEY_EXISTS');
    }
    const private_address =
      input.device_type === 'ADMIN' ? this.allocAdminIp() : this.allocClientIp();
    const role: VsRole = input.device_type === 'ADMIN' ? 'OWNER_ADMIN' : 'CLIENT';
    const rec: DeviceRecord = {
      device_id: input.device_id,
      device_name: input.device_name,
      device_type: input.device_type,
      public_key: input.public_key,
      key_fingerprint: fingerprintPublicKey(input.public_key),
      private_address,
      private_ip: private_address,
      client_id: input.client_id ?? null,
      account_id: input.account_id ?? null,
      owner_scope:
        input.owner_scope ??
        (input.client_id != null ? `client:${input.client_id}` : role === 'OWNER_ADMIN' ? 'owner' : null),
      role,
      permissions: [...permissionsForRole(role)],
      status: 'PENDING_APPROVAL',
      created_at: nowIso(),
      approved_at: null,
      last_seen: null,
      revoked_at: null,
      key_version: 1,
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
    const d = this.data.devices.find((x) => x.device_id === deviceId);
    if (!d) throw new Error('DEVICE_NOT_FOUND');
    if (d.status === 'REVOKED') throw new Error('DEVICE_REVOKED');
    d.status = 'ACTIVE';
    d.approved_at = nowIso();
    this.persist();
    return { ...d };
  }

  revoke(deviceId: string): DeviceRecord {
    const d = this.data.devices.find((x) => x.device_id === deviceId);
    if (!d) throw new Error('DEVICE_NOT_FOUND');
    d.status = 'REVOKED';
    d.revoked_at = nowIso();
    d.connection_state = 'REVOKED';
    d.session_id = null;
    this.persist();
    return { ...d };
  }

  rotatePublicKey(deviceId: string, newPublicKey: string, newDeviceToken: string): DeviceRecord {
    const d = this.data.devices.find((x) => x.device_id === deviceId);
    if (!d) throw new Error('DEVICE_NOT_FOUND');
    if (d.status === 'REVOKED') throw new Error('DEVICE_REVOKED');
    if (this.data.devices.some((x) => x.public_key === newPublicKey && x.device_id !== deviceId)) {
      throw new Error('PUBLIC_KEY_EXISTS');
    }
    d.public_key = newPublicKey;
    d.key_fingerprint = fingerprintPublicKey(newPublicKey);
    d.device_token_hash = hashToken(newDeviceToken);
    d.key_version = (d.key_version || 1) + 1;
    d.session_id = null;
    d.connection_state = 'DISCONNECTED';
    this.persist();
    return { ...d };
  }

  verifyDeviceToken(deviceId: string, token: string): boolean {
    const d = this.data.devices.find((x) => x.device_id === deviceId);
    if (!d || d.status !== 'ACTIVE') return false;
    if (!d.device_token_hash) return false;
    return d.device_token_hash === hashToken(token);
  }

  heartbeat(
    deviceId: string,
    opts?: { session_id?: string; latency_ms?: number | null }
  ): DeviceRecord {
    const d = this.data.devices.find((x) => x.device_id === deviceId);
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

  activePeers(): Array<{ public_key: string; private_ip: string; device_id: string }> {
    return this.data.devices
      .filter((d) => d.status === 'ACTIVE')
      .map((d) => ({
        public_key: d.public_key,
        private_ip: d.private_address || d.private_ip,
        device_id: d.device_id,
      }));
  }

  // ── Enrollment ──────────────────────────────────────────────

  createEnrollment(input: {
    token: string;
    device_type: 'ADMIN' | 'CLIENT';
    device_id?: string | null;
    client_id?: number | null;
    account_id?: number | null;
    ttl_ms: number;
    created_by: string;
  }): { enrollment_id: string; expires_at: string } {
    const enrollment_id = `ENR-${createHash('sha256').update(input.token).digest('hex').slice(0, 12)}`;
    const expires_at = new Date(Date.now() + input.ttl_ms).toISOString();
    this.data.enrollments.push({
      token_hash: hashToken(input.token),
      enrollment_id,
      device_type: input.device_type,
      device_id: input.device_id ?? null,
      client_id: input.client_id ?? null,
      account_id: input.account_id ?? null,
      created_at: nowIso(),
      expires_at,
      used_at: null,
      revoked_at: null,
      created_by: input.created_by,
    });
    this.persist();
    return { enrollment_id, expires_at };
  }

  getEnrollmentByToken(token: string): EnrollmentRecord | undefined {
    const h = hashToken(token);
    return this.data.enrollments.find((e) => e.token_hash === h);
  }

  revokeEnrollment(enrollmentId: string): void {
    const e = this.data.enrollments.find((x) => x.enrollment_id === enrollmentId);
    if (!e) throw new Error('ENROLLMENT_NOT_FOUND');
    e.revoked_at = nowIso();
    this.persist();
  }

  consumeEnrollment(token: string): EnrollmentRecord {
    const e = this.getEnrollmentByToken(token);
    if (!e) throw new Error('ENROLLMENT_INVALID');
    if (e.revoked_at) throw new Error('ENROLLMENT_REVOKED');
    if (e.used_at) throw new Error('ENROLLMENT_USED');
    if (Date.parse(e.expires_at) < Date.now()) throw new Error('ENROLLMENT_EXPIRED');
    e.used_at = nowIso();
    this.persist();
    return { ...e };
  }

  listEnrollments(): EnrollmentRecord[] {
    return this.data.enrollments.map((e) => ({ ...e }));
  }

  // ── Command idempotency ─────────────────────────────────────

  getCommandResult(commandId: string): unknown | undefined {
    return this.data.command_dedupe[commandId]?.result;
  }

  putCommandResult(commandId: string, deviceId: string, result: unknown): void {
    this.data.command_dedupe[commandId] = {
      result,
      at: nowIso(),
      device_id: deviceId,
    };
    this.persist();
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
  shared = new DeviceRegistry(dataRoot, { serverId: VS_DEFAULT_SERVER_ID });
  return shared;
}
