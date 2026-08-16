import type { LiveState } from '../hooks/useAdminLive';

export function ClientsPage({ live }: { live: LiveState }) {
  const rows = [
    ...live.presenceClients.map((c) => ({
      id: c.device_id,
      name: c.display_name,
      status: c.status,
      trading: '—',
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

  return (
    <div className="panel">
      <h3>CLIENTS</h3>
      {rows.length === 0 ? (
        <div className="empty">0 CLIENTS — enrollment creates real rows only</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>CLIENT</th>
              <th>DEVICE</th>
              <th>STATUS</th>
              <th>TRADING</th>
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
                  <span className={`dot ${String(r.status).includes('ONLINE') || r.status === 'CONNECTED' ? 'on' : 'off'}`} />
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
