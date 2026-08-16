import { useState } from 'react';
import type { LiveState } from '../hooks/useAdminLive';

function apiBase(): string {
  return localStorage.getItem('VS_API_BASE') || 'http://127.0.0.1:3000';
}
function token(): string {
  return localStorage.getItem('VS_ADMIN_TOKEN') || '';
}

export function ClientsPage({ live }: { live: LiveState }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const rows = [
    ...live.presenceClients.map((c) => ({
      id: c.device_id,
      name: c.display_name,
      status: c.status,
      trading: c.app_connected ? 'APP' : '—',
      vpn: c.wg_connected === true ? 'OK' : c.wg_connected === false ? 'DOWN' : 'UNKNOWN',
      last: 'heartbeat',
    })),
    ...live.devices.map((d) => ({
      id: d.device_id,
      name: d.device_id,
      status: d.connection_state || d.status,
      trading: '—',
      vpn: d.transport,
      last: d.last_seen_human || '—',
    })),
  ];

  async function createEnrollment() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(apiBase() + '/api/v1/network/enrollment/create', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-admin-token': token(),
        },
        body: JSON.stringify({ device_type: 'CLIENT' }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg(String(body.reason || body.code || `HTTP ${res.status}`));
        return;
      }
      setMsg(
        `Enrollment created. Code: ${body.enrollment_code || body.code || 'see server'} — export package via SERVER/EXPORT_CLIENT.sh`
      );
    } catch {
      setMsg('Request failed — server unreachable');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <h3>CLIENTS</h3>
      <div style={{ marginBottom: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="primary" type="button" disabled={busy || !live.connected} onClick={() => void createEnrollment()}>
          CREATE ENROLLMENT
        </button>
        <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>
          ENABLE / PAUSE / DISABLE / REVOKE via Control API network routes
        </span>
      </div>
      {msg ? <div className="empty" style={{ marginBottom: 12 }}>{msg}</div> : null}
      {rows.length === 0 ? (
        <div className="empty">0 CLIENTS — enrollment creates real rows only</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>CLIENT</th>
              <th>DEVICE</th>
              <th>STATUS</th>
              <th>APP / TRADING</th>
              <th>VPN</th>
              <th>LAST SEEN</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td className="muted">{r.id}</td>
                <td>
                  <span
                    className={`dot ${
                      String(r.status).includes('ONLINE') || r.status === 'CONNECTED' ? 'on' : 'off'
                    }`}
                  />
                  {r.status}
                </td>
                <td>{r.trading}</td>
                <td>{r.vpn}</td>
                <td className="muted">{r.last}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
