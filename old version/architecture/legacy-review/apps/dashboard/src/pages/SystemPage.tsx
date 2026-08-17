import { useApi } from '../hooks/useApi';
import type { ServerMonitor } from '../types/serverMonitor';

function Cell({
  label,
  status,
  extra,
}: {
  label: string;
  status: string;
  extra?: string;
}) {
  const st = (status || 'UNKNOWN').toUpperCase();
  const cls =
    st === 'ONLINE' || st === 'OK' || st === 'CONNECTED'
      ? 'on'
      : st === 'WARNING' || st === 'STARTING'
        ? 'warn'
        : st === 'UNKNOWN' || st === 'NOT_INSTALLED'
          ? ''
          : 'off';
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '6px 0' }}>
      <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{label}</span>
      <span style={{ fontWeight: 600, fontFamily: 'var(--font-mono)', fontSize: 13 }}>
        <span className={`dot ${cls}`} style={{ marginRight: 8 }} />
        {st}
        {extra ? `  ${extra}` : ''}
      </span>
    </div>
  );
}

export function SystemPage() {
  const {
    data: mon,
    error: monErr,
    loading,
  } = useApi<ServerMonitor>('/api/v1/server/monitor', 3000);
  const { data: settings } = useApi<Record<string, unknown>>('/api/settings');

  const offline = Boolean(monErr && !mon);

  return (
    <div>
      <h1 className="page-title">Server</h1>
      <p style={{ color: 'var(--text-secondary)', marginTop: -8, marginBottom: 16 }}>
        Authoritative status from i3 <code>/api/v1/server/monitor</code> — same contract as the
        physical console monitor. No demo values.
      </p>

      {offline && (
        <div className="card" style={{ marginBottom: 16, borderColor: 'var(--danger, #c44)' }}>
          <div className="section-title">SERVER OFFLINE</div>
          <div>Cannot reach i3 VS-CORE-01 monitor API.</div>
          <div style={{ color: 'var(--text-secondary)', marginTop: 8 }}>{monErr}</div>
        </div>
      )}

      {loading && !mon && <div className="card">Loading server monitor…</div>}

      {mon && (
        <div className="grid grid-2" style={{ marginBottom: 16, gap: 16 }}>
          <div className="card">
            <div className="section-title">
              {mon.server_id} — CORE SERVICES
            </div>
            <Cell label="SERVER PROCESS" status={mon.server_process.status} />
            <Cell label="CONTROL API" status={mon.api.status} extra={`:${mon.api.port}`} />
            <Cell label="POSTGRES" status={mon.database.status} />
            <Cell label="REDIS" status={mon.redis.status} />
            <Cell
              label="WIREGUARD"
              status={mon.wireguard.status}
              extra={`UDP :${mon.wireguard.listen_port} · peers ${mon.wireguard.peers}`}
            />
            <Cell
              label="NETWORK"
              status={mon.network.status}
              extra={mon.network.lan_ip || undefined}
            />
          </div>

          <div className="card">
            <div className="section-title">ADMIN / CLIENTS</div>
            <Cell
              label="MSI CONTROL"
              status={mon.admin.connected ? 'CONNECTED' : mon.admin.device_id ? 'DISCONNECTED' : 'UNKNOWN'}
            />
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8 }}>
              TRANSPORT {mon.admin.transport} · DEVICE {mon.admin.device_name || mon.admin.device_id || '—'}
              <br />
              LAST SEEN {mon.admin.last_seen_human || mon.admin.last_seen || '—'}
            </div>
            <Cell label="CLIENTS TOTAL" status={String(mon.clients.total)} />
            <div style={{ fontSize: 13 }}>
              Online {mon.clients.online} · Offline {mon.clients.offline}
            </div>
            {mon.clients.devices.slice(0, 8).map((d) => (
              <Cell
                key={d.device_id}
                label={d.device_id}
                status={
                  d.connection_state === 'CONNECTED' || d.connection_state === 'ONLINE'
                    ? 'ONLINE'
                    : 'OFFLINE'
                }
                extra={d.transport}
              />
            ))}
          </div>

          <div className="card">
            <div className="section-title">TRADING</div>
            <Cell label="MARKET" status={mon.market.state} />
            <Cell
              label="LIVE TRADING"
              status={mon.trading.enabled ? 'ENABLED' : 'DISABLED'}
            />
            <Cell label="STRATEGY" status={mon.strategy.status} />
            <Cell label="RISK" status={mon.risk.status} />
            <Cell label="EXECUTION" status={mon.execution.status} />
            <Cell label="RECONCILIATION" status={mon.reconciliation.status} />
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8 }}>
              Mode {mon.operating_mode} · readiness {mon.trading.readiness}
            </div>
          </div>

          <div className="card">
            <div className="section-title">SYSTEM</div>
            <Cell
              label="CPU"
              status={mon.system.cpu_percent != null ? `${mon.system.cpu_percent}%` : 'UNKNOWN'}
            />
            <Cell
              label="RAM"
              status={mon.system.ram_percent != null ? `${mon.system.ram_percent}%` : 'UNKNOWN'}
            />
            <Cell
              label="DISK"
              status={mon.system.disk_percent != null ? `${mon.system.disk_percent}%` : 'UNKNOWN'}
            />
            <div style={{ fontSize: 13, marginTop: 8 }}>
              Uptime {mon.uptime_human}
              <br />
              Version {mon.server_version}
              <br />
              Updated {mon.timestamp}
            </div>
            <div className="section-title" style={{ marginTop: 16 }}>
              LAST ERROR
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>
              {mon.last_error || 'NONE'}
            </div>
          </div>
        </div>
      )}

      {settings && (
        <div className="card">
          <div className="section-title">SETTINGS (read)</div>
          <pre style={{ fontSize: 11, overflow: 'auto' }}>
            {JSON.stringify(
              {
                mode: settings.mode ?? settings.operating_mode,
                live_enabled: settings.live_enabled,
              },
              null,
              2,
            )}
          </pre>
        </div>
      )}
    </div>
  );
}
