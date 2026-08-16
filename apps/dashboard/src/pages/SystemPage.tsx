import { useApi } from '../hooks/useApi';

type AdminSnapshot = {
  ok?: boolean;
  connection?: string;
  server_id?: string;
  hostname?: string;
  uptime_human?: string;
  host?: {
    cpu_percent?: number | null;
    ram_used_bytes?: number | null;
    ram_total_bytes?: number | null;
    ssd_used_bytes?: number | null;
    ssd_total_bytes?: number | null;
    network_online?: boolean;
    network_status?: string;
  };
  core?: { state?: string; live_ready?: boolean; reason_code?: string | null };
  market?: { status?: string; primary_feed?: string };
  strategy?: { status?: string };
  risk?: { status?: string };
  execution?: { status?: string };
  capital?: { status?: string };
  live_ready?: boolean;
};

function fmtBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export function SystemPage() {
  const {
    data: status,
    error: statusErr,
    loading: statusLoading,
  } = useApi<Record<string, unknown>>('/api/system/status', 3000);
  const { data: snap, error: snapErr } = useApi<AdminSnapshot>('/api/v1/admin/snapshot', 3000);
  const { data: settings } = useApi<Record<string, unknown>>('/api/settings');

  const offline = Boolean(statusErr && snapErr);

  return (
    <div>
      <h1 className="page-title">System</h1>

      {offline && (
        <div className="card" style={{ marginBottom: 16, borderColor: 'var(--danger, #c44)' }}>
          <div className="section-title">SERVER OFFLINE</div>
          <div>Cannot reach i3 VS-CORE-01. No cached READY/LIVE is shown.</div>
          <div style={{ color: 'var(--text-secondary)', marginTop: 8 }}>
            {statusErr || snapErr}
          </div>
        </div>
      )}

      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="section-title">SERVER (ADMIN SNAPSHOT)</div>
          {!snap && snapErr && <div>SERVER OFFLINE / {snapErr}</div>}
          {snap && (
            <div className="grid grid-2" style={{ gap: 8 }}>
              <div>
                <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>server_id</span>
                <div style={{ fontWeight: 600 }}>{snap.server_id || '—'}</div>
              </div>
              <div>
                <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>connection</span>
                <div style={{ fontWeight: 600 }}>{snap.connection || '—'}</div>
              </div>
              <div>
                <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>uptime</span>
                <div style={{ fontWeight: 600 }}>{snap.uptime_human || '—'}</div>
              </div>
              <div>
                <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>core</span>
                <div style={{ fontWeight: 600 }}>{snap.core?.state || '—'}</div>
              </div>
              <div>
                <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>CPU</span>
                <div style={{ fontWeight: 600 }}>
                  {snap.host?.cpu_percent != null ? `${snap.host.cpu_percent}%` : '—'}
                </div>
              </div>
              <div>
                <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>RAM</span>
                <div style={{ fontWeight: 600 }}>
                  {fmtBytes(snap.host?.ram_used_bytes)} / {fmtBytes(snap.host?.ram_total_bytes)}
                </div>
              </div>
              <div>
                <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>Disk</span>
                <div style={{ fontWeight: 600 }}>
                  {fmtBytes(snap.host?.ssd_used_bytes)} / {fmtBytes(snap.host?.ssd_total_bytes)}
                </div>
              </div>
              <div>
                <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>Network</span>
                <div style={{ fontWeight: 600 }}>{snap.host?.network_status || '—'}</div>
              </div>
              <div>
                <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>Market</span>
                <div style={{ fontWeight: 600 }}>{snap.market?.status || '—'}</div>
              </div>
              <div>
                <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>Strategy</span>
                <div style={{ fontWeight: 600 }}>{snap.strategy?.status || '—'}</div>
              </div>
              <div>
                <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>Execution</span>
                <div style={{ fontWeight: 600 }}>{snap.execution?.status || '—'}</div>
              </div>
              <div>
                <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>Capital</span>
                <div style={{ fontWeight: 600 }}>{snap.capital?.status || '—'}</div>
              </div>
              <div>
                <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>LIVE_READY</span>
                <div style={{ fontWeight: 600 }}>
                  {snap.live_ready === true || snap.core?.live_ready === true ? 'true' : 'false'}
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="card">
          <div className="section-title">Process Health {statusLoading ? '…' : ''}</div>
          {statusErr && !status ? (
            <div>SERVER OFFLINE</div>
          ) : (
            <div className="grid grid-2" style={{ gap: 8 }}>
              {['market_core', 'execution', 'database', 'control_api', 'mode', 'git_sha'].map((k) => (
                <div key={k}>
                  <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{k}</span>
                  <div style={{ fontWeight: 600 }}>{String(status?.[k] ?? '—')}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="section-title">Configuration (server-reported)</div>
        <pre style={{ fontSize: 12, overflow: 'auto' }}>
          {settings ? JSON.stringify(settings, null, 2) : statusErr ? 'SERVER OFFLINE' : '—'}
        </pre>
      </div>
    </div>
  );
}
