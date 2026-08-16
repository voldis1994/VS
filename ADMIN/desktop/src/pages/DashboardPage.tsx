import type { LiveState } from '../hooks/useAdminLive';

export function DashboardPage({ live }: { live: LiveState }) {
  return (
    <>
      <div className="cards">
        <div className="card">
          <div className="label">SERVER HEALTH</div>
          <div className={`value ${live.health === 'HEALTHY' ? 'green' : ''}`}>{live.health}</div>
        </div>
        <div className="card">
          <div className="label">UPTIME</div>
          <div className="value">{live.uptime || '—'}</div>
        </div>
        <div className="card">
          <div className="label">CLIENTS</div>
          <div className="value green">
            {live.clientsOnline}
            <span className="muted" style={{ fontSize: 14 }}> / {live.clientsRegistered}</span>
          </div>
        </div>
        <div className="card">
          <div className="label">TOTAL P/L TODAY</div>
          <div className="value muted">{live.totalPnlToday == null ? 'NO DATA' : live.totalPnlToday}</div>
        </div>
      </div>

      <div className="grid2">
        <div className="panel">
          <h3>MARKET OVERVIEW</h3>
          <div>
            Status: <strong>{live.marketStatus}</strong>
          </div>
          <div className="muted" style={{ marginTop: 8 }}>{live.marketDetail}</div>
          <div className="empty">NO CHART — waiting for live ticks from VS CORE</div>
        </div>
        <div className="panel">
          <h3>SERVER RESOURCES</h3>
          <table>
            <tbody>
              <tr><td>CPU</td><td>{live.cpu == null ? '—' : `${live.cpu}%`}</td></tr>
              <tr><td>RAM</td><td>{live.ram == null ? '—' : `${live.ram}%`}</td></tr>
              <tr><td>SSD</td><td>{live.disk == null ? '—' : `${live.disk}%`}</td></tr>
            </tbody>
          </table>
        </div>
        <div className="panel">
          <h3>CLIENT STATUS</h3>
          {live.devices.length === 0 && live.presenceClients.length === 0 ? (
            <div className="empty">0 CLIENTS</div>
          ) : (
            <table>
              <thead>
                <tr><th>CLIENT</th><th>STATUS</th><th>TRANSPORT</th><th>LAST SEEN</th></tr>
              </thead>
              <tbody>
                {live.presenceClients.map((c) => (
                  <tr key={c.device_id}>
                    <td><span className={`dot ${c.app_connected ? 'on' : 'off'}`} />{c.display_name}</td>
                    <td>{c.status}</td>
                    <td>WG {c.wg_connected === true ? 'OK' : c.wg_connected === false ? '--' : '??'}</td>
                    <td className="muted">heartbeat</td>
                  </tr>
                ))}
                {live.devices.map((d) => (
                  <tr key={d.device_id}>
                    <td><span className={`dot ${d.connection_state === 'CONNECTED' ? 'on' : 'off'}`} />{d.device_id}</td>
                    <td>{d.connection_state || d.status}</td>
                    <td>{d.transport}</td>
                    <td className="muted">{d.last_seen_human || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="panel">
          <h3>INCIDENTS</h3>
          {live.lastError ? (
            <div style={{ color: 'var(--red)' }}>{live.lastError}</div>
          ) : (
            <div className="empty">NO OPEN INCIDENTS</div>
          )}
        </div>
        <div className="panel">
          <h3>RECENT ORDERS</h3>
          <div className="empty">NO DATA</div>
        </div>
        <div className="panel">
          <h3>QUICK ACTIONS</h3>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            Actions call real Control API only — no pretend success.
          </div>
          <button
            className="primary"
            onClick={async () => {
              const ok = window.confirm('Request database backup on VS-CORE-01?');
              if (!ok) return;
              alert('Backup must be run via SERVER/install/BACKUP_SERVER.sh or backup API when enabled.');
            }}
          >
            Backup Database
          </button>
        </div>
      </div>
    </>
  );
}
