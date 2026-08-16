/**
 * ADMIN Connection Manager — product UX knows SERVER_ID only (no :3000).
 */

export type AdminProductConfig = {
  server_id: string;
  device_id: string;
  device_token?: string;
  enrollment_code?: string;
};

/** Internal catalog — WG private host is FALLBACK only when LAN URL unset and tunnel ready. */
const INTERNAL = {
  private_host: '10.77.0.1',
  private_port: 3000,
};

/**
 * Resolve ADMIN HTTP base URL.
 * Prefer explicit override / LAN env. Never silently force WireGuard when a LAN URL is configured.
 */
export function resolveAdminBaseUrl(serverId: string, override?: string): string {
  if (override) return override.replace(/\/$/, '');
  const lan = (
    process.env.VS_LAN_SERVER_URL ||
    process.env.VS_SERVER_URL ||
    ''
  ).trim();
  if (lan) return lan.replace(/\/$/, '');
  void serverId;
  // Last resort for enrolled remote ADMIN with active tunnel — not used for home-LAN MSI
  if (process.env.VS_ADMIN_TRANSPORT === 'wireguard') {
    return `http://${INTERNAL.private_host}:${INTERNAL.private_port}`;
  }
  // Do not default to WireGuard for home ADMIN — caller must discover LAN first
  return '';
}

export type ManagerState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'WIREGUARD_NOT_READY' | 'AUTH_FAILED';

export class AdminConnectionManager {
  private cfg: AdminProductConfig & { endpoint_override?: string };
  private sessionId: string | null = null;
  private state: ManagerState = 'DISCONNECTED';
  private fetchImpl: typeof fetch;

  constructor(
    cfg: AdminProductConfig & { endpoint_override?: string },
    fetchImpl: typeof fetch = fetch
  ) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
  }

  /** User-facing: server_id + device_id only. */
  userFacing(): { server_id: string; device_id: string } {
    return { server_id: this.cfg.server_id, device_id: this.cfg.device_id };
  }

  getState(): ManagerState {
    return this.state;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  async authenticate(): Promise<{ ok: boolean; code?: string }> {
    if (!this.cfg.device_token) return { ok: false, code: 'NO_DEVICE_TOKEN' };
    this.state = 'CONNECTING';
    const base = resolveAdminBaseUrl(this.cfg.server_id, this.cfg.endpoint_override);
    try {
      const res = await this.fetchImpl(`${base}/api/v1/network/device/auth`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          device_id: this.cfg.device_id,
          device_token: this.cfg.device_token,
        }),
      });
      const body = (await res.json()) as { session_id?: string; code?: string };
      if (!res.ok || !body.session_id) {
        this.state = 'AUTH_FAILED';
        return { ok: false, code: body.code || `HTTP_${res.status}` };
      }
      this.sessionId = body.session_id;
      this.state = 'CONNECTED';
      return { ok: true };
    } catch (e) {
      this.state = 'DISCONNECTED';
      return { ok: false, code: e instanceof Error ? e.message : 'NETWORK_ERROR' };
    }
  }

  /** Reconnect — never replays trading/admin state commands. */
  async reconnect(): Promise<{ ok: boolean; trading_commands_replayed: false }> {
    if (!this.sessionId) {
      const a = await this.authenticate();
      return { ok: a.ok, trading_commands_replayed: false };
    }
    const base = resolveAdminBaseUrl(this.cfg.server_id, this.cfg.endpoint_override);
    try {
      const res = await this.fetchImpl(`${base}/api/v1/network/device/reconnect`, {
        method: 'POST',
        headers: { 'x-vs-session': this.sessionId },
      });
      this.state = res.ok ? 'CONNECTED' : 'DISCONNECTED';
      return { ok: res.ok, trading_commands_replayed: false };
    } catch {
      this.state = 'DISCONNECTED';
      return { ok: false, trading_commands_replayed: false };
    }
  }
}
