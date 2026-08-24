import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { apiFetch } from '../../hooks/useApi';
import { fmtTime } from '../lib/format';

type ClientRow = {
  id: number;
  name: string;
  enabled: boolean;
  access_enabled?: boolean;
  has_access_code?: boolean;
  preferred_broker_account_id?: number | null;
  panel_epic?: string | null;
  panel_display_name?: string | null;
  panel_lot_size?: number | null;
  panel_multi_market?: boolean;
  robot_status?: 'RUNNING' | 'STOPPED';
  account_id?: number | null;
  last_seen_at?: string | null;
};

type TradingAccount = {
  account_id: number;
  client_id: number;
  display_name: string;
  environment: string;
};

export function ClientsView() {
  const [rows, setRows] = useState<ClientRow[]>([]);
  const [accounts, setAccounts] = useState<TradingAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [issuedCode, setIssuedCode] = useState<{ client_id: number; code: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const [c, a] = await Promise.all([
        apiFetch<ClientRow[]>('/api/clients'),
        apiFetch<TradingAccount[]>('/api/trading/accounts').catch(() => []),
      ]);
      setRows(c);
      setAccounts(a);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Load failed');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 8000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!rows.length) {
      setFocusId(null);
      return;
    }
    setFocusId((prev) => (prev && rows.some((c) => c.id === prev) ? prev : rows[0]!.id));
  }, [rows]);

  const focused = rows.find((c) => c.id === focusId) || null;
  const focusAccounts = focused ? accounts.filter((a) => a.client_id === focused.id) : [];
  const panelOn = rows.filter((c) => c.access_enabled && c.has_access_code).length;
  const robotsOn = rows.filter((c) => c.robot_status === 'RUNNING').length;
  const shareUrl = import.meta.env.VITE_CLIENT_PANEL_URL || 'VS.bat → Cloudflare link';

  const handleCreate = async () => {
    if (!name.trim()) return;
    setSubmitting(true);
    setMsg(null);
    try {
      await apiFetch('/api/clients', { method: 'POST', body: JSON.stringify({ name }) });
      setName('');
      await refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Create failed');
    } finally {
      setSubmitting(false);
    }
  };

  const putClient = async (client: ClientRow, body: Record<string, unknown>) => {
    setMsg(null);
    await apiFetch(`/api/clients/${client.id}`, { method: 'PUT', body: JSON.stringify(body) });
    await refresh();
  };

  const handleGenerateCode = async (client: ClientRow) => {
    setMsg(null);
    try {
      const res = await apiFetch<{ access_code: string; client_id: number }>(
        `/api/clients/${client.id}/access-code`,
        { method: 'POST', body: JSON.stringify({}) },
      );
      setIssuedCode({ client_id: res.client_id, code: res.access_code });
      setMsg('Access code issued — copy now');
      await refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Code failed');
    }
  };

  if (loading && !rows.length) return <div className="cmd-empty">Loading clients…</div>;
  if (error && !rows.length) return <div className="cmd-banner cmd-banner--err">{error}</div>;

  return (
    <div>
      <PageHeader
        kicker="VS SYSTEM // CLIENT DESKS"
        title="Clients"
        stats={[
          { label: 'Total', value: rows.length },
          { label: 'Panel', value: panelOn },
          { label: 'Robots', value: robotsOn },
        ]}
        actions={
          <Link className="cmd-btn" to="/client">
            Client preview
          </Link>
        }
      />

      <section className="cmd-panel" style={{ marginBottom: '1rem' }}>
        <div className="cmd-section-title">Share URL</div>
        <p className="mono" style={{ margin: 0, fontSize: '0.78rem' }}>
          {shareUrl} · Admin preview: <Link to="/client">/client</Link>
        </p>
      </section>

      <div className="cmd-deploy-row" style={{ marginBottom: '1rem' }}>
        <input
          className="cmd-input"
          placeholder="New client name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleCreate();
          }}
        />
        <button className="cmd-btn cmd-btn--primary" type="button" disabled={submitting} onClick={() => void handleCreate()}>
          Add client
        </button>
      </div>

      {msg && <div className="cmd-banner cmd-banner--ok">{msg}</div>}
      {issuedCode && (
        <div className="cmd-code" style={{ marginBottom: '1rem' }}>
          CODE #{issuedCode.client_id}: <strong>{issuedCode.code}</strong>
        </div>
      )}

      <div className="cmd-client-stage">
        <div className="cmd-roster">
          {rows.length === 0 && <div className="cmd-empty">No clients yet</div>}
          {rows.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`cmd-roster-row ${focusId === c.id ? 'active' : ''}`}
              onClick={() => setFocusId(c.id)}
            >
              <span className="mono">#{c.id}</span>
              <strong>{c.name}</strong>
              <span className={`cmd-badge ${c.enabled ? 'cmd-badge--ok' : 'cmd-badge--bad'}`}>
                {c.enabled ? 'ON' : 'OFF'}
              </span>
              <span className={`cmd-badge ${c.access_enabled && c.has_access_code ? 'cmd-badge--ok' : 'cmd-badge--bad'}`}>
                {c.access_enabled && c.has_access_code ? 'PANEL' : 'NO ACCESS'}
              </span>
              <span className={`cmd-badge ${c.panel_multi_market ? 'cmd-badge--ok' : 'cmd-badge--bad'}`}>
                {c.panel_multi_market ? 'MULTI' : '1-MKT'}
              </span>
              <span className={`cmd-badge ${c.robot_status === 'RUNNING' ? 'cmd-badge--ok' : 'cmd-badge--bad'}`}>
                {c.robot_status || 'STOPPED'}
              </span>
            </button>
          ))}
        </div>

        <section className="cmd-panel cmd-focus">
          {focused ? (
            <>
              <div className="cmd-kicker">Focus client</div>
              <div className="cmd-focus-name">
                #{focused.id} · {focused.name}
              </div>
              <div className="cmd-focus-metrics mono">
                <div>
                  <span>MARKET</span>
                  <strong>
                    {focused.panel_display_name || focused.panel_epic || '—'}
                    {focused.panel_lot_size != null ? ` / ${focused.panel_lot_size}` : ''}
                  </strong>
                </div>
                <div>
                  <span>LAST SEEN</span>
                  <strong>{fmtTime(focused.last_seen_at)}</strong>
                </div>
              </div>
              <div className="cmd-section-title">Broker account</div>
              <select
                className="cmd-select"
                value={focused.preferred_broker_account_id ?? focused.account_id ?? ''}
                onChange={(e) =>
                  void putClient(focused, {
                    preferred_broker_account_id: e.target.value === '' ? null : Number(e.target.value),
                  })
                }
              >
                <option value="">Auto / first</option>
                {focusAccounts.map((a) => (
                  <option key={a.account_id} value={a.account_id}>
                    #{a.account_id} · {a.display_name} ({a.environment})
                  </option>
                ))}
              </select>
              <div className="cmd-page-actions" style={{ marginTop: '0.75rem' }}>
                <button className="cmd-btn" type="button" onClick={() => void putClient(focused, { enabled: !focused.enabled })}>
                  {focused.enabled ? 'Disable' : 'Enable'}
                </button>
                <button className="cmd-btn cmd-btn--go" type="button" onClick={() => void handleGenerateCode(focused)}>
                  {focused.has_access_code ? 'Reset code' : 'Generate code'}
                </button>
                <button
                  className="cmd-btn"
                  type="button"
                  onClick={() =>
                    void apiFetch(`/api/multi-market/clients/${focused.id}/multi`, {
                      method: 'POST',
                      body: JSON.stringify({ enabled: !focused.panel_multi_market }),
                    }).then(async () => {
                      setMsg(
                        focused.panel_multi_market
                          ? 'Multi-market OFF — epic-locked'
                          : 'Multi-market ON — accepts selector picks'
                      );
                      await refresh();
                    })
                  }
                >
                  {focused.panel_multi_market ? 'Multi OFF' : 'Multi ON'}
                </button>
                <button
                  className="cmd-btn"
                  type="button"
                  onClick={() => void putClient(focused, { access_enabled: !focused.access_enabled })}
                >
                  {focused.access_enabled ? 'Access off' : 'Access on'}
                </button>
                <button
                  className="cmd-btn"
                  type="button"
                  onClick={async () => {
                    await apiFetch(`/api/clients/${focused.id}/revoke-access`, {
                      method: 'POST',
                      body: JSON.stringify({}),
                    });
                    setMsg('Access revoked');
                    await refresh();
                  }}
                >
                  Revoke
                </button>
                <button
                  className="cmd-btn cmd-btn--stop"
                  type="button"
                  disabled={focused.robot_status !== 'RUNNING'}
                  onClick={async () => {
                    await apiFetch(`/api/clients/${focused.id}/stop-robot`, {
                      method: 'POST',
                      body: JSON.stringify({}),
                    });
                    setMsg('Robot stopped');
                    await refresh();
                  }}
                >
                  Stop robot
                </button>
                <button
                  className="cmd-btn cmd-btn--danger"
                  type="button"
                  onClick={async () => {
                    if (!window.confirm(`Delete "${focused.name}" permanently?`)) return;
                    await apiFetch(`/api/clients/${focused.id}?hard=true`, { method: 'DELETE' });
                    setMsg('Deleted');
                    await refresh();
                  }}
                >
                  Delete
                </button>
              </div>
            </>
          ) : (
            <div className="cmd-empty">Select a client</div>
          )}
        </section>
      </div>
    </div>
  );
}
