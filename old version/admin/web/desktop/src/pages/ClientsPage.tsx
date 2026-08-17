import { useCallback, useEffect, useState } from 'react';
import type { LiveState } from '../hooks/useAdminLive';

type DbClient = {
  id: number;
  name: string;
  enabled: boolean;
  access_enabled: boolean;
  has_access_code: boolean;
  robot_status?: string;
  panel_epic?: string | null;
  panel_lot_size?: number | null;
  last_seen_at?: string | null;
};

type ProvisionResult = {
  client_id: number;
  login: string;
  password: string;
  panel_url: string;
  panel_url_vpn?: string;
  panel_url_lan?: string;
  message?: string;
  wg_warning?: string | null;
  wireguard?: {
    enrollment_code?: string;
    device_id?: string;
    expires_at?: string;
    server_endpoint_hostname?: string | null;
    wg_listen_port?: number;
    vpn_panel_url?: string;
    note?: string;
    steps?: string[];
  } | null;
};

function apiBase(): string {
  return localStorage.getItem('VS_API_BASE') || 'http://127.0.0.1:3000';
}
function token(): string {
  return localStorage.getItem('VS_ADMIN_TOKEN') || '';
}
function headers(): HeadersInit {
  return {
    'content-type': 'application/json',
    'x-admin-token': token(),
  };
}

export function ClientsPage({ live }: { live: LiveState }) {
  const [rows, setRows] = useState<DbClient[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [creds, setCreds] = useState<ProvisionResult | null>(null);

  const load = useCallback(async () => {
    if (!live.connected) return;
    try {
      const res = await fetch(apiBase() + '/api/clients', { headers: headers() });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = (await res.json()) as DbClient[];
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Failed to load clients');
    }
  }, [live.connected]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 8000);
    return () => clearInterval(t);
  }, [load]);

  async function createWebClient() {
    const login = name.trim();
    if (!login) {
      setMsg('Enter client login name');
      return;
    }
    setBusy(true);
    setMsg(null);
    setCreds(null);
    try {
      const res = await fetch(apiBase() + '/api/clients/provision-web', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ name: login }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg(String(body.message || body.error || `HTTP ${res.status}`));
        return;
      }
      setCreds(body as ProvisionResult);
      setName('');
      await load();
    } catch {
      setMsg('Request failed — server unreachable');
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword(id: number) {
    if (!window.confirm('Generate a new password? Old sessions will be revoked.')) return;
    setBusy(true);
    try {
      const res = await fetch(apiBase() + `/api/clients/${id}/access-code`, {
        method: 'POST',
        headers: headers(),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg(String(body.message || body.error || `HTTP ${res.status}`));
        return;
      }
      const client = rows.find((r) => r.id === id);
      setCreds({
        client_id: id,
        login: client?.name || String(id),
        password: body.access_code,
        panel_url: 'http://10.77.0.1:3000/',
        panel_url_vpn: 'http://10.77.0.1:3000/',
        message: body.message,
      });
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: number) {
    if (!window.confirm('Revoke web access for this client?')) return;
    setBusy(true);
    try {
      await fetch(apiBase() + `/api/clients/${id}/revoke-access`, {
        method: 'POST',
        headers: headers(),
      });
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function stopRobot(id: number) {
    setBusy(true);
    try {
      await fetch(apiBase() + `/api/clients/${id}/stop-robot`, {
        method: 'POST',
        headers: headers(),
      });
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <h3>CLIENTS</h3>
      <p className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
        Outside Wi‑Fi customers need WireGuard first, then web login. They choose market + lot and START/STOP
        robot.
      </p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <input
          style={{
            flex: 1,
            minWidth: 180,
            padding: '8px 10px',
            borderRadius: 6,
            border: '1px solid #1c242c',
            background: '#0c1014',
            color: '#f3f7f5',
          }}
          placeholder="Client login name"
          value={name}
          disabled={!live.connected || busy}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void createWebClient();
          }}
        />
        <button
          className="primary"
          type="button"
          disabled={busy || !live.connected || !name.trim()}
          onClick={() => void createWebClient()}
        >
          CREATE REMOTE CLIENT
        </button>
      </div>

      {msg ? (
        <div className="empty" style={{ marginBottom: 12 }}>
          {msg}
        </div>
      ) : null}

      {creds ? (
        <div className="empty" style={{ marginBottom: 16, textAlign: 'left' }}>
          <strong style={{ color: 'var(--green)' }}>SAVE NOW — password shown once</strong>
          <div style={{ marginTop: 10 }}>
            <div>
              <strong>Login:</strong> {creds.login}
            </div>
            <div>
              <strong>Password:</strong> {creds.password}
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            <strong>Remote URL (after WireGuard):</strong> {creds.panel_url_vpn || creds.panel_url}
          </div>
          {creds.panel_url_lan ? (
            <div className="muted" style={{ fontSize: 12 }}>
              LAN only (same Wi‑Fi): {creds.panel_url_lan}
            </div>
          ) : null}
          {creds.wireguard ? (
            <div style={{ marginTop: 12 }}>
              <strong>WireGuard enrollment (remote):</strong>
              <div style={{ wordBreak: 'break-all' }}>Code: {creds.wireguard.enrollment_code}</div>
              <div>Device: {creds.wireguard.device_id}</div>
              <div>
                Endpoint:{' '}
                {creds.wireguard.server_endpoint_hostname
                  ? `${creds.wireguard.server_endpoint_hostname}:${creds.wireguard.wg_listen_port}`
                  : `NOT SET — configure PUBLIC_HOST_OR_IP on i3 + UDP ${creds.wireguard.wg_listen_port} forward`}
              </div>
              <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                {creds.wireguard.note}
              </div>
              <ol style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12 }}>
                {(creds.wireguard.steps || []).map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
            </div>
          ) : null}
          {creds.wg_warning ? (
            <div style={{ color: 'var(--red)', marginTop: 8 }}>WG warning: {creds.wg_warning}</div>
          ) : null}
          <div className="muted" style={{ marginTop: 8, fontSize: 11 }}>
            {creds.message}
          </div>
          <button type="button" className="primary" style={{ marginTop: 10 }} onClick={() => setCreds(null)}>
            Cleared / Saved
          </button>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="empty">0 CLIENTS — create a remote client above</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>LOGIN</th>
              <th>ACCESS</th>
              <th>ROBOT</th>
              <th>MARKET</th>
              <th>LOT</th>
              <th>ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td>
                  <span className={`dot ${r.access_enabled && r.has_access_code ? 'on' : 'off'}`} />
                  {r.access_enabled ? 'ENABLED' : 'REVOKED'}
                </td>
                <td>{r.robot_status || 'STOPPED'}</td>
                <td className="muted">{r.panel_epic || '—'}</td>
                <td className="muted">{r.panel_lot_size ?? '—'}</td>
                <td>
                  <button type="button" disabled={busy} onClick={() => void resetPassword(r.id)}>
                    New password
                  </button>{' '}
                  <button type="button" disabled={busy} onClick={() => void stopRobot(r.id)}>
                    Stop
                  </button>{' '}
                  <button type="button" disabled={busy} onClick={() => void revoke(r.id)}>
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
