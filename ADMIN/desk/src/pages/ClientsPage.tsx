import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi, apiFetch } from '../hooks/useApi';

interface LiveTrade {
  market: string;
  display_name: string;
  trade_type: string;
  lot_size: number;
  entry_price: number | null;
}

interface ClientRow {
  id: number;
  name: string;
  enabled: boolean;
  access_enabled?: boolean;
  has_access_code?: boolean;
  preferred_broker_account_id?: number | null;
  panel_epic?: string | null;
  panel_display_name?: string | null;
  panel_lot_size?: number | null;
  robot_status?: 'RUNNING' | 'STOPPED';
  live_trade?: LiveTrade | null;
  account_id?: number | null;
  last_seen_at?: string | null;
  created_at: string;
}

interface TradingAccount {
  account_id: number;
  client_id: number;
  client_name: string;
  display_name: string;
  environment: string;
}

export function ClientsPage() {
  const { data, error, loading, refresh } = useApi<ClientRow[]>('/api/clients');
  const [accounts, setAccounts] = useState<TradingAccount[]>([]);
  const [name, setName] = useState('');
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [issuedCode, setIssuedCode] = useState<{ client_id: number; code: string } | null>(null);

  useEffect(() => {
    void apiFetch<TradingAccount[]>('/api/trading/accounts')
      .then((rows) => setAccounts(rows || []))
      .catch(() => setAccounts([]));
  }, []);

  const handleCreate = async () => {
    if (!name.trim()) return;
    setSubmitting(true);
    setMsg(null);
    try {
      await apiFetch('/api/clients', { method: 'POST', body: JSON.stringify({ name }) });
      setName('');
      refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Failed to create account');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRename = async (client: ClientRow) => {
    const next = (drafts[client.id] ?? client.name).trim();
    if (!next) {
      setMsg('Name required');
      return;
    }
    if (next === client.name) return;
    setMsg(null);
    try {
      await apiFetch(`/api/clients/${client.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: next }),
      });
      setDrafts((d) => {
        const copy = { ...d };
        delete copy[client.id];
        return copy;
      });
      setMsg(`Renamed to "${next}"`);
      refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Rename failed');
    }
  };

  const handleToggle = async (client: ClientRow) => {
    setMsg(null);
    await apiFetch(`/api/clients/${client.id}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled: !client.enabled }),
    });
    refresh();
  };

  const handleAccessToggle = async (client: ClientRow) => {
    setMsg(null);
    await apiFetch(`/api/clients/${client.id}`, {
      method: 'PUT',
      body: JSON.stringify({ access_enabled: !client.access_enabled }),
    });
    refresh();
  };

  const handleGenerateCode = async (client: ClientRow) => {
    setMsg(null);
    try {
      const res = await apiFetch<{ access_code: string; client_id: number }>(
        `/api/clients/${client.id}/access-code`,
        { method: 'POST', body: JSON.stringify({}) }
      );
      setIssuedCode({ client_id: res.client_id, code: res.access_code });
      setMsg(`Access code issued for #${client.id}. Copy it now — shown once.`);
      refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Access code failed');
    }
  };

  const handleRevoke = async (client: ClientRow) => {
    if (!window.confirm(`Revoke Client Panel access for "${client.name}"?`)) return;
    await apiFetch(`/api/clients/${client.id}/revoke-access`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    setMsg(`Access revoked for #${client.id}`);
    refresh();
  };

  const handleAdminStop = async (client: ClientRow) => {
    await apiFetch(`/api/clients/${client.id}/stop-robot`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    setMsg(`Stopped robot for #${client.id}`);
    refresh();
  };

  const handlePreferredAccount = async (client: ClientRow, accountId: number | '') => {
    await apiFetch(`/api/clients/${client.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        preferred_broker_account_id: accountId === '' ? null : Number(accountId),
      }),
    });
    refresh();
  };

  const handleDelete = async (client: ClientRow) => {
    const ok = window.confirm(
      `DELETE account "${client.name}" (#${client.id})?\n\nThis permanently removes brokers, credentials, and trading settings.`
    );
    if (!ok) return;
    setMsg(null);
    try {
      await apiFetch(`/api/clients/${client.id}?hard=true`, { method: 'DELETE' });
      setMsg(`Deleted account #${client.id}`);
      refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Delete failed');
    }
  };

  if (loading) return <div className="empty-state">LOADING ACCOUNTS...</div>;
  if (error) return <div className="error-state">{error}</div>;

  return (
    <div>
      <h1 className="page-title">Clients</h1>
      <p className="page-subtitle">
        Client desks + access codes. Change the name in the roster (Save) — ROBOT BOARD updates live.
        Send clients this link (not the admin desk):
      </p>
      <div className="card" style={{ marginBottom: 16, padding: '12px 16px' }}>
        <div className="section-title" style={{ marginBottom: 8 }}>
          Client panel URL (share this)
        </div>
        <p className="mono" style={{ fontSize: 14, wordBreak: 'break-all' }}>
          {import.meta.env.VITE_CLIENT_PANEL_URL ||
            'Double-click VS.bat → copy https://….trycloudflare.com from that window'}
        </p>
        <p style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
          Client is <strong>not</strong> on your Wi‑Fi — do not send a 192.168.x.x IP. Keep{' '}
          <code>VS.bat</code> open, send the https tunnel link + access code. Admin preview:{' '}
          <Link to="/client">/client</Link>
        </p>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="section-title">Add Client</div>
        <div className="actions">
          <input
            className="input"
            placeholder="Account / client name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ maxWidth: 320 }}
          />
          <button className="btn btn-primary" onClick={handleCreate} disabled={submitting}>
            Add Client
          </button>
        </div>
        {msg && <p style={{ marginTop: 10, fontFamily: 'var(--font-mono)', fontSize: 12 }}>{msg}</p>}
        {issuedCode && (
          <div className="error-state" style={{ marginTop: 12, color: 'var(--accent)' }}>
            Access code for client #{issuedCode.client_id}:{' '}
            <strong className="mono">{issuedCode.code}</strong>
          </div>
        )}
      </div>

      <div className="card">
        <div className="section-title">Client Roster</div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Name</th>
                <th>Enabled</th>
                <th>Access</th>
                <th>Broker account</th>
                <th>Market / Lot</th>
                <th>Robot</th>
                <th>Trade</th>
                <th>Last seen</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {(data || []).map((c) => {
                const clientAccounts = accounts.filter((a) => a.client_id === c.id);
                return (
                  <tr key={c.id}>
                    <td className="mono">#{c.id}</td>
                    <td>
                      <div className="actions" style={{ flexWrap: 'nowrap', alignItems: 'center' }}>
                        <input
                          className="input"
                          style={{ minWidth: 140, maxWidth: 220 }}
                          value={drafts[c.id] ?? c.name}
                          onChange={(e) =>
                            setDrafts((d) => ({ ...d, [c.id]: e.target.value }))
                          }
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void handleRename(c);
                          }}
                        />
                        <button
                          className="btn btn-primary"
                          disabled={(drafts[c.id] ?? c.name).trim() === c.name}
                          onClick={() => void handleRename(c)}
                        >
                          Save
                        </button>
                      </div>
                    </td>
                    <td>
                      <span className={`badge ${c.enabled ? 'badge-healthy' : 'badge-unhealthy'}`}>
                        {c.enabled ? 'ON' : 'OFF'}
                      </span>
                    </td>
                    <td>
                      <span
                        className={`badge ${
                          c.access_enabled && c.has_access_code ? 'badge-healthy' : 'badge-unhealthy'
                        }`}
                      >
                        {c.access_enabled && c.has_access_code ? 'PANEL' : 'NO ACCESS'}
                      </span>
                    </td>
                    <td>
                      <select
                        className="input"
                        style={{ minWidth: 160 }}
                        value={c.preferred_broker_account_id ?? c.account_id ?? ''}
                        onChange={(e) =>
                          void handlePreferredAccount(
                            c,
                            e.target.value === '' ? '' : Number(e.target.value)
                          )
                        }
                      >
                        <option value="">Auto / first</option>
                        {clientAccounts.map((a) => (
                          <option key={a.account_id} value={a.account_id}>
                            #{a.account_id} · {a.display_name} ({a.environment})
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="mono">
                      {c.panel_display_name || c.panel_epic || '—'}
                      {c.panel_lot_size != null ? ` / ${c.panel_lot_size}` : ''}
                    </td>
                    <td>
                      <span
                        className={`badge ${
                          c.robot_status === 'RUNNING' ? 'badge-healthy' : 'badge-unhealthy'
                        }`}
                      >
                        {c.robot_status || 'STOPPED'}
                      </span>
                    </td>
                    <td className="mono">
                      {c.live_trade
                        ? `${c.live_trade.trade_type} ${c.live_trade.lot_size}`
                        : '—'}
                    </td>
                    <td className="mono">
                      {c.last_seen_at ? new Date(c.last_seen_at).toLocaleString() : '—'}
                    </td>
                    <td>
                      <div className="actions" style={{ flexWrap: 'wrap' }}>
                        <button className="btn" onClick={() => void handleToggle(c)}>
                          {c.enabled ? 'Disable' : 'Enable'}
                        </button>
                        <button className="btn btn-go" onClick={() => void handleGenerateCode(c)}>
                          {c.has_access_code ? 'Reset Code' : 'Generate Code'}
                        </button>
                        <button className="btn" onClick={() => void handleAccessToggle(c)}>
                          {c.access_enabled ? 'Access Off' : 'Access On'}
                        </button>
                        <button className="btn" onClick={() => void handleRevoke(c)}>
                          Revoke
                        </button>
                        <button
                          className="btn btn-stop"
                          disabled={c.robot_status !== 'RUNNING'}
                          onClick={() => void handleAdminStop(c)}
                        >
                          STOP
                        </button>
                        <button className="btn btn-danger" onClick={() => void handleDelete(c)}>
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {(!data || data.length === 0) && <div className="empty-state">NO CLIENTS YET</div>}
      </div>
    </div>
  );
}
