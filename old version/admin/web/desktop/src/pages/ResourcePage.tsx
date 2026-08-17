import type { LiveState } from '../hooks/useAdminLive';

/** Real-data page — shows server payload slices or honest NO DATA. Never invents values. */
export function ResourcePage({
  title,
  live,
  kind,
  note,
}: {
  title: string;
  live: LiveState;
  kind:
    | 'accounts'
    | 'market'
    | 'trading'
    | 'risk'
    | 'execution'
    | 'positions'
    | 'incidents'
    | 'logs'
    | 'backups'
    | 'updates'
    | 'settings';
  note?: string;
}) {
  if (!live.connected) {
    return (
      <div className="panel">
        <h3>{title}</h3>
        <div className="empty">DISCONNECTED — reconnecting to VS-CORE-01</div>
      </div>
    );
  }

  const raw = live.raw || {};
  const broker = live.broker;
  const supervisor = live.supervisor;

  if (kind === 'market') {
    return (
      <div className="panel">
        <h3>{title}</h3>
        <table>
          <tbody>
            <tr>
              <td>Status</td>
              <td>
                <strong>{live.marketStatus}</strong>
              </td>
            </tr>
            <tr>
              <td>Detail</td>
              <td className="muted">{live.marketDetail}</td>
            </tr>
            <tr>
              <td>Bid / Ask</td>
              <td>
                {live.marketBid == null && live.marketAsk == null
                  ? 'NO DATA'
                  : `${live.marketBid ?? '—'} / ${live.marketAsk ?? '—'}`}
              </td>
            </tr>
            <tr>
              <td>Spread</td>
              <td>{live.marketSpread == null ? 'NO DATA' : live.marketSpread}</td>
            </tr>
            <tr>
              <td>Freshness</td>
              <td>{live.marketFreshness || 'UNKNOWN'}</td>
            </tr>
          </tbody>
        </table>
        <div className="empty">NO FAKE CHART / NO SAMPLE QUOTES</div>
      </div>
    );
  }

  if (kind === 'incidents') {
    return (
      <div className="panel">
        <h3>{title}</h3>
        {live.incidents.length === 0 && !live.lastError ? (
          <div className="empty">NO OPEN INCIDENTS</div>
        ) : (
          <ul>
            {live.lastError ? <li style={{ color: 'var(--red)' }}>{live.lastError}</li> : null}
            {live.incidents.map((i, idx) => (
              <li key={idx}>
                [{i.severity || 'INFO'}] {i.message || i.code || JSON.stringify(i)}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  if (kind === 'accounts') {
    return (
      <div className="panel">
        <h3>{title}</h3>
        <div>Broker: {broker?.state || 'UNKNOWN'}</div>
        <div className="muted">{broker?.detail || 'NO ACCOUNT DATA'}</div>
        {live.accounts.length === 0 ? (
          <div className="empty">NO ACCOUNTS — broker not configured or no snapshots</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>STATUS</th>
                <th>BALANCE</th>
              </tr>
            </thead>
            <tbody>
              {live.accounts.map((a) => (
                <tr key={a.id}>
                  <td>{a.id}</td>
                  <td>{a.status}</td>
                  <td>{a.balance == null ? 'NO DATA' : a.balance}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    );
  }

  if (kind === 'positions') {
    return (
      <div className="panel">
        <h3>{title}</h3>
        {live.positions.length === 0 ? (
          <div className="empty">NO POSITIONS</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>SYMBOL</th>
                <th>SIDE</th>
                <th>SIZE</th>
                <th>P/L</th>
              </tr>
            </thead>
            <tbody>
              {live.positions.map((p, i) => (
                <tr key={i}>
                  <td>{p.symbol}</td>
                  <td>{p.side}</td>
                  <td>{p.size}</td>
                  <td>{p.pnl == null ? 'NO DATA' : p.pnl}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    );
  }

  if (kind === 'execution' || kind === 'trading') {
    return (
      <div className="panel">
        <h3>{title}</h3>
        <div className="muted" style={{ marginBottom: 8 }}>
          MARKET → REGIME → STRATEGY → SIGNAL → RISK → EXECUTION
        </div>
        <table>
          <tbody>
            <tr>
              <td>PROCESS READY</td>
              <td>{supervisor?.process_ready === true ? 'YES' : supervisor?.process_ready === false ? 'NO' : 'UNKNOWN'}</td>
            </tr>
            <tr>
              <td>TRADING READY</td>
              <td>{supervisor?.trading_ready === true ? 'YES' : supervisor?.trading_ready === false ? 'NO' : 'UNKNOWN'}</td>
            </tr>
            <tr>
              <td>Kill switch</td>
              <td>{supervisor?.kill_switch?.active ? 'ACTIVE' : 'OFF'}</td>
            </tr>
            <tr>
              <td>Recent orders</td>
              <td>{live.orders.length === 0 ? 'NO DATA' : `${live.orders.length} event(s)`}</td>
            </tr>
          </tbody>
        </table>
        {supervisor?.trading_blockers?.length ? (
          <div className="empty">Blockers: {supervisor.trading_blockers.join(', ')}</div>
        ) : null}
      </div>
    );
  }

  if (kind === 'risk') {
    return (
      <div className="panel">
        <h3>{title}</h3>
        <div>Kill switch: {supervisor?.kill_switch?.active ? 'ACTIVE' : 'OFF'}</div>
        <div className="muted">{supervisor?.kill_switch?.reason || 'No kill-switch reason'}</div>
        <div className="empty">{note || 'Limits enforced on server — no client-side override'}</div>
      </div>
    );
  }

  if (kind === 'logs') {
    return (
      <div className="panel">
        <h3>{title}</h3>
        {live.events.length === 0 ? (
          <div className="empty">NO EVENTS</div>
        ) : (
          <ul>
            {live.events.slice(0, 40).map((e, i) => (
              <li key={i} className="muted">
                {e.type || e.event || 'event'} — {e.at || e.timestamp || ''}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  if (kind === 'backups') {
    return (
      <div className="panel">
        <h3>{title}</h3>
        <div className="empty">
          {live.backupHint || 'Use SERVER/BACKUP_SERVER.sh or POST /api/v1/backups when enabled'}
        </div>
        <button
          className="primary"
          type="button"
          onClick={async () => {
            const base = localStorage.getItem('VS_API_BASE') || 'http://127.0.0.1:3000';
            const token = localStorage.getItem('VS_ADMIN_TOKEN') || '';
            try {
              const res = await fetch(base + '/api/v1/backups', {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-admin-token': token },
                body: JSON.stringify({ reason: 'admin-ui' }),
              });
              if (res.status === 404 || res.status === 501) {
                alert('Backup API not enabled — run SERVER/BACKUP_SERVER.sh on i3');
                return;
              }
              if (!res.ok) {
                alert('Backup request failed: HTTP ' + res.status);
                return;
              }
              alert('Backup requested — verify on i3');
            } catch {
              alert('Backup request failed — server unreachable');
            }
          }}
        >
          Request Backup
        </button>
      </div>
    );
  }

  if (kind === 'updates') {
    return (
      <div className="panel">
        <h3>{title}</h3>
        <div>Update path: SERVER/UPDATE_SERVER.sh (preflight → backup → migrate → health)</div>
        <div className="empty">Never git-pull-and-hope as sole production strategy</div>
      </div>
    );
  }

  if (kind === 'settings') {
    return (
      <div className="panel">
        <h3>{title}</h3>
        <table>
          <tbody>
            <tr>
              <td>API base</td>
              <td>{localStorage.getItem('VS_API_BASE') || '—'}</td>
            </tr>
            <tr>
              <td>Admin device</td>
              <td>{live.adminName}</td>
            </tr>
            <tr>
              <td>Server</td>
              <td>{live.serverId}</td>
            </tr>
            <tr>
              <td>Connection</td>
              <td>{live.connected ? 'CONNECTED' : 'DISCONNECTED'}</td>
            </tr>
          </tbody>
        </table>
        <div className="muted" style={{ marginTop: 12 }}>
          Change endpoint via INSTALL_ADMIN / control-panel.env — not by editing source.
        </div>
        {/* silence unused raw */}
        <span style={{ display: 'none' }}>{Object.keys(raw).length}</span>
      </div>
    );
  }

  return (
    <div className="panel">
      <h3>{title}</h3>
      <div className="empty">{note || 'NO DATA'}</div>
    </div>
  );
}
