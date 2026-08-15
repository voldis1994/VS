/**
 * Admin Connection Client — talks to VS SERVER Admin Service.
 * All status comes from SERVER. Local state is connection status only.
 */

export type ConnectionState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'AUTH_FAILED' | 'ERROR';

export type AdminConnectionConfig = {
  baseUrl: string;
  adminToken: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
};

export type ServerSnapshot = {
  ok: boolean;
  server_id?: string;
  hostname?: string;
  uptime_human?: string;
  uptime_seconds?: number;
  time_utc?: string;
  host?: {
    cpu_percent?: number | null;
    ram_used_bytes?: number | null;
    ram_total_bytes?: number | null;
    ssd_used_bytes?: number | null;
    ssd_total_bytes?: number | null;
    network_online?: boolean;
    network_latency_ms?: number | null;
  };
  core?: { state?: string; live_ready?: boolean; reason_code?: string | null };
  market?: { status?: string; primary_feed?: string; feed_age_ms?: number | null };
  strategy?: { status?: string; detail?: string };
  risk?: { status?: string; detail?: string };
  execution?: { status?: string; detail?: string };
  capital?: { status?: string; detail?: string };
  reconciliation?: { status?: string; detail?: string };
  incidents?: { unresolved?: number; critical?: number };
  clients?: { count?: number | null; trading?: number | null };
  positions?: { count?: number | null };
  live_ready?: boolean;
  [k: string]: unknown;
};

export type AdminConnectionStatus = {
  state: ConnectionState;
  last_error: string | null;
  last_ping_ms: number | null;
  last_snapshot: ServerSnapshot | null;
  last_success_at: string | null;
  server_id: string | null;
};

function fmtBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return 'NO DATA';
  const gb = n / (1024 ** 3);
  return `${gb.toFixed(1)} GB`;
}

export class AdminConnectionClient {
  private cfg: AdminConnectionConfig;
  private status: AdminConnectionStatus = {
    state: 'DISCONNECTED',
    last_error: null,
    last_ping_ms: null,
    last_snapshot: null,
    last_success_at: null,
    server_id: null,
  };
  private timer: ReturnType<typeof setInterval> | null = null;
  private fetchImpl: typeof fetch;

  constructor(cfg: AdminConnectionConfig, fetchImpl: typeof fetch = fetch) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
  }

  getStatus(): AdminConnectionStatus {
    return { ...this.status, last_snapshot: this.status.last_snapshot };
  }

  /** When disconnected, do not present stale snapshot as LIVE. */
  displaySnapshot(): ServerSnapshot | null {
    if (this.status.state !== 'CONNECTED') return null;
    return this.status.last_snapshot;
  }

  async ping(): Promise<{ ok: boolean; ping_ms: number | null; error?: string }> {
    const t0 = Date.now();
    try {
      this.status.state = this.status.state === 'DISCONNECTED' ? 'CONNECTING' : this.status.state;
      const res = await this.fetchImpl(`${this.cfg.baseUrl.replace(/\/$/, '')}/api/v1/admin/ping`, {
        headers: { 'x-admin-token': this.cfg.adminToken },
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 5000),
      });
      const ping_ms = Date.now() - t0;
      if (res.status === 401) {
        this.status.state = 'AUTH_FAILED';
        this.status.last_error = 'UNAUTHORIZED';
        this.status.last_ping_ms = ping_ms;
        return { ok: false, ping_ms, error: 'UNAUTHORIZED' };
      }
      if (!res.ok) {
        this.status.state = 'ERROR';
        this.status.last_error = `HTTP_${res.status}`;
        this.status.last_ping_ms = ping_ms;
        return { ok: false, ping_ms, error: `HTTP_${res.status}` };
      }
      const body = (await res.json()) as { server_id?: string };
      this.status.state = 'CONNECTED';
      this.status.last_error = null;
      this.status.last_ping_ms = ping_ms;
      this.status.server_id = body.server_id || this.status.server_id;
      this.status.last_success_at = new Date().toISOString();
      return { ok: true, ping_ms };
    } catch (e) {
      this.status.state = 'DISCONNECTED';
      this.status.last_error = e instanceof Error ? e.message : String(e);
      this.status.last_ping_ms = null;
      // Clear live presentation — do not keep showing last values as current
      this.status.last_snapshot = null;
      return { ok: false, ping_ms: null, error: this.status.last_error };
    }
  }

  async fetchSnapshot(): Promise<ServerSnapshot | null> {
    const ping = await this.ping();
    if (!ping.ok) return null;
    try {
      const res = await this.fetchImpl(
        `${this.cfg.baseUrl.replace(/\/$/, '')}/api/v1/admin/snapshot`,
        {
          headers: { 'x-admin-token': this.cfg.adminToken },
          signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 8000),
        }
      );
      if (res.status === 401) {
        this.status.state = 'AUTH_FAILED';
        this.status.last_error = 'UNAUTHORIZED';
        this.status.last_snapshot = null;
        return null;
      }
      if (!res.ok) {
        this.status.state = 'ERROR';
        this.status.last_error = `HTTP_${res.status}`;
        this.status.last_snapshot = null;
        return null;
      }
      const snap = (await res.json()) as ServerSnapshot;
      this.status.state = 'CONNECTED';
      this.status.last_snapshot = snap;
      this.status.server_id = snap.server_id || this.status.server_id;
      this.status.last_success_at = new Date().toISOString();
      this.status.last_error = null;
      return snap;
    } catch (e) {
      this.status.state = 'DISCONNECTED';
      this.status.last_error = e instanceof Error ? e.message : String(e);
      this.status.last_snapshot = null;
      return null;
    }
  }

  startPolling(onUpdate?: (s: AdminConnectionStatus) => void): void {
    const interval = this.cfg.pollIntervalMs ?? 2000;
    void this.fetchSnapshot().then(() => onUpdate?.(this.getStatus()));
    this.timer = setInterval(() => {
      void this.fetchSnapshot().then(() => onUpdate?.(this.getStatus()));
    }, interval);
  }

  stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Render diagnostic screen from REAL server data only. */
  renderDiagnostic(): string {
    const st = this.getStatus();
    const lines: string[] = [];
    lines.push('VS ADMIN');
    lines.push('');
    if (st.state !== 'CONNECTED') {
      lines.push(`CONNECTION`);
      lines.push(st.state);
      if (st.last_error) lines.push(`ERROR  ${st.last_error}`);
      lines.push('');
      lines.push('(No live SERVER snapshot while disconnected)');
      return lines.join('\n');
    }
    const s = st.last_snapshot;
    if (!s) {
      lines.push('CONNECTION  CONNECTED');
      lines.push('SNAPSHOT    NO DATA');
      return lines.join('\n');
    }
    const h = s.host || {};
    lines.push(`SERVER`);
    lines.push(String(s.server_id || 'NO DATA'));
    lines.push('');
    lines.push(`CONNECTION`);
    lines.push('CONNECTED');
    lines.push('');
    lines.push(`PING`);
    lines.push(st.last_ping_ms != null ? `${st.last_ping_ms} ms` : 'NO DATA');
    lines.push('');
    lines.push(`CORE`);
    lines.push(String(s.core?.state || 'NOT READY'));
    lines.push('');
    lines.push(`MARKET`);
    lines.push(String(s.market?.status || s.market?.primary_feed || 'NO DATA'));
    lines.push('');
    lines.push(`STRATEGY`);
    lines.push(String(s.strategy?.status || 'NO DATA'));
    lines.push('');
    lines.push(`RISK`);
    lines.push(String(s.risk?.status || 'NO DATA'));
    lines.push('');
    lines.push(`EXECUTION`);
    lines.push(String(s.execution?.status || 'NO DATA'));
    lines.push('');
    lines.push(`CAPITAL`);
    lines.push(String(s.capital?.status || 'NO DATA'));
    lines.push('');
    lines.push(`CPU`);
    lines.push(h.cpu_percent != null ? `${h.cpu_percent}%` : 'NO DATA');
    lines.push('');
    lines.push(`RAM`);
    lines.push(
      h.ram_used_bytes != null && h.ram_total_bytes != null
        ? `${fmtBytes(h.ram_used_bytes)} / ${fmtBytes(h.ram_total_bytes)}`
        : 'NO DATA'
    );
    lines.push('');
    lines.push(`SSD`);
    lines.push(
      h.ssd_used_bytes != null && h.ssd_total_bytes != null
        ? `${fmtBytes(h.ssd_used_bytes)} / ${fmtBytes(h.ssd_total_bytes)}`
        : 'NO DATA'
    );
    lines.push('');
    lines.push(`UPTIME`);
    lines.push(String(s.uptime_human || 'NO DATA'));
    lines.push('');
    lines.push(`INCIDENTS`);
    lines.push(`${s.incidents?.critical ?? 0} CRITICAL / ${s.incidents?.unresolved ?? 0} unresolved`);
    lines.push('');
    lines.push(`LIVE_READY`);
    lines.push(s.live_ready === true ? 'true' : 'false');
    return lines.join('\n');
  }
}
