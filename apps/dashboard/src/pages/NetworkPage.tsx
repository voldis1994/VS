import { useApi, apiFetch } from '../hooks/useApi';
import { useState } from 'react';

type DeviceRow = {
  device_id: string;
  device_type: string;
  status: string;
  private_address?: string;
  connection_state?: string;
  client_id?: number | null;
  last_seen?: string | null;
};

type EnrollmentRow = {
  enrollment_id: string;
  device_type: string;
  device_id?: string | null;
  status: string;
  expires_at: string;
  client_id?: number | null;
};

type NetworkStatus = {
  ok?: boolean;
  meta?: { server_id?: string; wg_listen_port?: number; server_endpoint_hostname?: string | null };
  counts?: Record<string, number>;
  devices?: DeviceRow[];
  text?: string;
};

type Snapshot = {
  server_id?: string;
  connection?: string;
  host?: { network_online?: boolean; network_status?: string };
  core?: { state?: string; live_ready?: boolean };
};

export function NetworkPage() {
  const { data: net, error, loading, refresh } = useApi<NetworkStatus>('/api/v1/network/status', 5000);
  const { data: enrollments, refresh: refreshEnr } = useApi<{ enrollments: EnrollmentRow[] }>(
    '/api/v1/network/enrollments',
    8000,
  );
  const { data: snap } = useApi<Snapshot>('/api/v1/admin/snapshot', 5000);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastCode, setLastCode] = useState<string | null>(null);
  const [clientId, setClientId] = useState('1');

  const createEnrollment = async (device_type: 'ADMIN' | 'CLIENT') => {
    setBusy(true);
    setMsg(null);
    setLastCode(null);
    try {
      const body: Record<string, unknown> = { device_type };
      if (device_type === 'ADMIN') body.device_id = 'VS-ADMIN-01';
      if (device_type === 'CLIENT') {
        const id = Number(clientId);
        if (!Number.isFinite(id)) throw new Error('client_id required');
        body.client_id = id;
      }
      const res = await apiFetch<{
        enrollment_code: string;
        enrollment_id: string;
        device_id: string;
        expires_at: string;
      }>('/api/v1/network/enrollment/create', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setLastCode(res.enrollment_code);
      setMsg(`Created ${res.device_id} — give enrollment code to the device (shown once).`);
      refresh();
      refreshEnr();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const revokeEnrollment = async (enrollment_id: string) => {
    setBusy(true);
    try {
      await apiFetch('/api/v1/network/enrollment/revoke', {
        method: 'POST',
        body: JSON.stringify({ enrollment_id }),
      });
      setMsg(`Revoked ${enrollment_id}`);
      refreshEnr();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const revokeDevice = async (device_id: string) => {
    setBusy(true);
    try {
      await apiFetch('/api/v1/network/device/revoke', {
        method: 'POST',
        body: JSON.stringify({ device_id }),
      });
      setMsg(`Revoked device ${device_id}`);
      refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const offline = Boolean(error) && !net;

  return (
    <div>
      <h1 className="page-title">Network & Enrollment</h1>
      <p style={{ color: 'var(--text-secondary)', marginBottom: 16 }}>
        Private WireGuard + device registry on i3 VS-CORE-01. Remote clients use the tunnel — not the MSI Wi-Fi.
      </p>

      {offline && (
        <div className="card" style={{ borderColor: 'var(--danger, #c44)', marginBottom: 16 }}>
          <div className="section-title">SERVER OFFLINE</div>
          <div>{error}</div>
        </div>
      )}

      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="section-title">SERVER LINK</div>
          <div>Identity: {snap?.server_id || net?.meta?.server_id || '—'}</div>
          <div>Admin channel: {snap?.connection || (offline ? 'OFFLINE' : '—')}</div>
          <div>Core: {snap?.core?.state || '—'}</div>
          <div>LIVE_READY (server): {snap?.core?.live_ready === true ? 'true' : 'false'}</div>
          <div>
            WG port: {net?.meta?.wg_listen_port ?? '—'} · endpoint host:{' '}
            {net?.meta?.server_endpoint_hostname || '—'}
          </div>
        </div>
        <div className="card">
          <div className="section-title">CREATE ENROLLMENT</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button type="button" className="btn btn-primary" disabled={busy || offline} onClick={() => void createEnrollment('ADMIN')}>
              New ADMIN enroll
            </button>
            <input
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              style={{ width: 72 }}
              title="client_id"
              aria-label="client_id"
            />
            <button type="button" className="btn" disabled={busy || offline} onClick={() => void createEnrollment('CLIENT')}>
              New CLIENT enroll
            </button>
          </div>
          {lastCode && (
            <div style={{ marginTop: 12, fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>
              enrollment_code (show once): {lastCode}
            </div>
          )}
          {msg && <div style={{ marginTop: 8 }}>{msg}</div>}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="section-title">DEVICES {loading ? '…' : ''}</div>
        <table className="data-table" style={{ width: '100%', fontSize: 13 }}>
          <thead>
            <tr>
              <th>ID</th>
              <th>Type</th>
              <th>Status</th>
              <th>Net</th>
              <th>Address</th>
              <th>Last seen</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(net?.devices || []).map((d) => (
              <tr key={d.device_id}>
                <td>{d.device_id}</td>
                <td>{d.device_type}</td>
                <td>{d.status}</td>
                <td>{d.connection_state || '—'}</td>
                <td>{d.private_address || '—'}</td>
                <td>{d.last_seen ? new Date(d.last_seen).toLocaleString() : '—'}</td>
                <td>
                  <button type="button" className="btn" disabled={busy} onClick={() => void revokeDevice(d.device_id)}>
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
            {!offline && (net?.devices || []).length === 0 && (
              <tr>
                <td colSpan={7}>No devices registered yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="section-title">ENROLLMENTS</div>
        <table className="data-table" style={{ width: '100%', fontSize: 13 }}>
          <thead>
            <tr>
              <th>ID</th>
              <th>Type</th>
              <th>Device</th>
              <th>Status</th>
              <th>Expires</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(enrollments?.enrollments || []).map((e) => (
              <tr key={e.enrollment_id}>
                <td>{e.enrollment_id}</td>
                <td>{e.device_type}</td>
                <td>{e.device_id || '—'}</td>
                <td>{e.status}</td>
                <td>{e.expires_at ? new Date(e.expires_at).toLocaleString() : '—'}</td>
                <td>
                  {e.status === 'PENDING' && (
                    <button type="button" className="btn" disabled={busy} onClick={() => void revokeEnrollment(e.enrollment_id)}>
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
