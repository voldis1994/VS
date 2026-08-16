import type { LiveState } from '../hooks/useAdminLive';

export function ServersPage({ live }: { live: LiveState }) {
  const snap = live.raw as Record<string, any> | null;
  return (
    <div className="panel">
      <h3>VS-CORE-01</h3>
      {!live.connected || !snap ? (
        <div className="empty">SERVER DISCONNECTED</div>
      ) : (
        <table>
          <tbody>
            <tr><td>Status</td><td>{live.health}</td></tr>
            <tr><td>Uptime</td><td>{live.uptime || '—'}</td></tr>
            <tr><td>Version</td><td>{snap.server_version || '—'}</td></tr>
            <tr><td>Control API</td><td>{snap.api?.status || '—'}</td></tr>
            <tr><td>Database</td><td>{snap.database?.status || '—'}</td></tr>
            <tr><td>Redis</td><td>{snap.redis?.status || '—'}</td></tr>
            <tr><td>WireGuard</td><td>{snap.wireguard?.status || '—'}</td></tr>
            <tr><td>Network</td><td>{snap.network?.status || '—'} {snap.network?.lan_ip || ''}</td></tr>
            <tr><td>Broker / LIVE</td><td>{snap.live_trading_enabled ? 'LIVE FLAG ON' : 'TRADING DISABLED'}</td></tr>
          </tbody>
        </table>
      )}
    </div>
  );
}
