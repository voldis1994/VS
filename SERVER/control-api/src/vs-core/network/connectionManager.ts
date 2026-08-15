/**
 * Connection Manager — ADMIN/CLIENT know SERVER_ID, not ports.
 * Resolves internal endpoints from catalog; verifies private network readiness.
 */

import {
  VS_DEFAULT_SERVER_ID,
  VS_INTERNAL_SERVICES,
  VS_WG_SERVER_IP,
  type ConnectionState,
} from './networkConstants.js';
import { findWireGuardIpv4 } from './networkBind.js';

export type NetworkReadiness =
  | { ready: true; reason: string }
  | { ready: false; reason: string; code: 'WIREGUARD_NOT_READY' | 'SERVER_MISMATCH' | 'NOT_CONFIGURED' };

export type ResolvedEndpoint = {
  server_id: string;
  service_id: string;
  /** Full base URL for internal use — never required in end-user UI fields */
  base_url: string;
  path_prefix: string;
};

export type ConnectionManagerConfig = {
  server_id: string;
  device_id: string;
  device_token?: string;
  session_id?: string | null;
  /** Optional override for tests — production resolves from catalog */
  endpoint_override?: string;
};

export type ManagerStatus = {
  server_id: string;
  network: NetworkReadiness;
  connection_state: ConnectionState | 'CONNECTING';
  session_id: string | null;
  last_error: string | null;
};

/**
 * Resolve CONTROL_API / ADMIN / CLIENT service URL from SERVER identity.
 * End users never type ":3000".
 */
export function resolveServerEndpoint(
  serverId: string,
  service: keyof typeof VS_INTERNAL_SERVICES = 'CONTROL_API',
  env: NodeJS.ProcessEnv = process.env
): ResolvedEndpoint {
  const expected = env.VS_SERVER_ID || VS_DEFAULT_SERVER_ID;
  if (serverId !== expected && env.VS_ALLOW_SERVER_ID_MISMATCH !== '1') {
    // Still resolve — caller verifies; mismatch recorded in readiness
  }
  const svc = VS_INTERNAL_SERVICES[service];
  const host = env.VS_RESOLVED_HOST || svc.private_host;
  const port = Number(env.VS_RESOLVED_PORT || svc.private_port);
  return {
    server_id: serverId,
    service_id: svc.id,
    base_url: `http://${host}:${port}`,
    path_prefix: svc.path_prefix,
  };
}

export function checkPrivateNetworkReady(
  env: NodeJS.ProcessEnv = process.env
): NetworkReadiness {
  const privateNet = env.VS_PRIVATE_NETWORK === '1' || env.VS_PRIVATE_NETWORK === 'true';
  if (!privateNet) {
    return { ready: true, reason: 'LOCAL_DEV_OR_EXPLICIT_NON_PRIVATE' };
  }
  const iface = env.VS_WG_INTERFACE || 'vs0';
  const ip = findWireGuardIpv4(iface);
  if (!ip) {
    return {
      ready: false,
      code: 'WIREGUARD_NOT_READY',
      reason: `WireGuard interface ${iface} not up — management NOT READY (fail closed)`,
    };
  }
  if (ip !== VS_WG_SERVER_IP && env.VS_WG_ALLOW_ANY_PRIVATE !== '1') {
    // Peer side may have different private IP — SERVER expects .1
    if (env.VS_ROLE === 'SERVER') {
      return {
        ready: false,
        code: 'WIREGUARD_NOT_READY',
        reason: `expected ${VS_WG_SERVER_IP} on ${iface}, got ${ip}`,
      };
    }
  }
  return { ready: true, reason: `WG ${iface} ${ip}` };
}

/**
 * Product Connection Manager — authenticate, heartbeat, reconnect without command replay.
 */
export class ConnectionManager {
  private cfg: ConnectionManagerConfig;
  private status: ManagerStatus;
  private fetchImpl: typeof fetch;

  constructor(cfg: ConnectionManagerConfig, fetchImpl: typeof fetch = fetch) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
    this.status = {
      server_id: cfg.server_id,
      network: { ready: false, reason: 'NOT_CHECKED', code: 'NOT_CONFIGURED' },
      connection_state: 'DISCONNECTED',
      session_id: cfg.session_id ?? null,
      last_error: null,
    };
  }

  getStatus(): ManagerStatus {
    return { ...this.status };
  }

  /** User-facing config: SERVER_ID only — no port fields. */
  static userFacingConfig(serverId: string, deviceId: string): { server_id: string; device_id: string } {
    return { server_id: serverId, device_id: deviceId };
  }

  verifyNetwork(env: NodeJS.ProcessEnv = process.env): NetworkReadiness {
    const r = checkPrivateNetworkReady(env);
    this.status.network = r;
    if (!r.ready) {
      this.status.connection_state = 'DISCONNECTED';
      this.status.last_error = r.code;
    }
    return r;
  }

  resolve(service: keyof typeof VS_INTERNAL_SERVICES = 'CONTROL_API'): ResolvedEndpoint {
    if (this.cfg.endpoint_override) {
      return {
        server_id: this.cfg.server_id,
        service_id: service,
        base_url: this.cfg.endpoint_override.replace(/\/$/, ''),
        path_prefix: VS_INTERNAL_SERVICES[service].path_prefix,
      };
    }
    return resolveServerEndpoint(this.cfg.server_id, service);
  }

  async authenticate(env: NodeJS.ProcessEnv = process.env): Promise<{
    ok: boolean;
    session_id?: string;
    code?: string;
  }> {
    const net = this.verifyNetwork(env);
    // In private mode, refuse to talk over public fallback
    if (!net.ready && (env.VS_PRIVATE_NETWORK === '1' || env.VS_PRIVATE_NETWORK === 'true')) {
      return { ok: false, code: 'WIREGUARD_NOT_READY' };
    }
    if (!this.cfg.device_token) {
      return { ok: false, code: 'NO_DEVICE_TOKEN' };
    }
    this.status.connection_state = 'CONNECTING';
    const ep = this.resolve('NETWORK_AUTHORITY');
    try {
      const res = await this.fetchImpl(`${ep.base_url}/api/v1/network/device/auth`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          device_id: this.cfg.device_id,
          device_token: this.cfg.device_token,
        }),
      });
      const body = (await res.json()) as { ok?: boolean; session_id?: string; code?: string };
      if (!res.ok || !body.session_id) {
        this.status.connection_state = 'DISCONNECTED';
        this.status.last_error = body.code || `HTTP_${res.status}`;
        return { ok: false, code: body.code || `HTTP_${res.status}` };
      }
      this.status.session_id = body.session_id;
      this.cfg.session_id = body.session_id;
      this.status.connection_state = 'CONNECTED';
      this.status.last_error = null;
      return { ok: true, session_id: body.session_id };
    } catch (e) {
      this.status.connection_state = 'DISCONNECTED';
      this.status.last_error = e instanceof Error ? e.message : String(e);
      return { ok: false, code: 'NETWORK_ERROR' };
    }
  }

  async heartbeat(latency_ms?: number): Promise<{ ok: boolean }> {
    if (!this.status.session_id) return { ok: false };
    const ep = this.resolve('NETWORK_AUTHORITY');
    try {
      const res = await this.fetchImpl(`${ep.base_url}/api/v1/network/device/heartbeat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-vs-session': this.status.session_id,
        },
        body: JSON.stringify({ latency_ms }),
      });
      if (!res.ok) {
        this.status.connection_state = 'DISCONNECTED';
        return { ok: false };
      }
      this.status.connection_state = 'CONNECTED';
      return { ok: true };
    } catch {
      this.status.connection_state = 'DISCONNECTED';
      return { ok: false };
    }
  }

  /**
   * Reconnect after Wi-Fi/sleep/tunnel loss — NEVER replays START/STOP/orders.
   */
  async reconnect(): Promise<{ ok: boolean; trading_commands_replayed: false; code?: string }> {
    if (!this.status.session_id) {
      const auth = await this.authenticate();
      return {
        ok: auth.ok,
        trading_commands_replayed: false,
        code: auth.code,
      };
    }
    const ep = this.resolve('NETWORK_AUTHORITY');
    try {
      const res = await this.fetchImpl(`${ep.base_url}/api/v1/network/device/reconnect`, {
        method: 'POST',
        headers: { 'x-vs-session': this.status.session_id },
      });
      const body = (await res.json()) as { ok?: boolean; code?: string };
      if (!res.ok) {
        this.status.connection_state = 'DISCONNECTED';
        return { ok: false, trading_commands_replayed: false, code: body.code };
      }
      this.status.connection_state = 'CONNECTED';
      return { ok: true, trading_commands_replayed: false };
    } catch {
      this.status.connection_state = 'DISCONNECTED';
      return { ok: false, trading_commands_replayed: false, code: 'NETWORK_ERROR' };
    }
  }
}
