import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
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
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const view = params.get('view') === 'info' ? 'info' : 'command';
  const setView = (next: 'command' | 'info') => {
    const q = new URLSearchParams(params);
    if (next === 'info') q.set('view', 'info');
    else q.delete('view');
    navigate({ pathname: '/clients', search: q.toString() ? `?${q}` : '' }, { replace: true });
  };

  const [accounts, setAccounts] = useState<TradingAccount[]>([]);
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [issuedCode, setIssuedCode] = useState<{ client_id: number; code: string } | null>(null);
  const [focusId, setFocusId] = useState<number | null>(null);

  useEffect(() => {
    void apiFetch<TradingAccount[]>('/api/trading/accounts')
      .then((rows) => setAccounts(rows || []))
      .catch(() => setAccounts([]));
  }, []);

  useEffect(() => {
    if (!data?.length) {
      setFocusId(null);
      return;
    }
    setFocusId((prev) => (prev && data.some((c) => c.id === prev) ? prev : data[0].id));
  }, [data]);

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
        { method: 'POST', body: JSON.stringify({}) },
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
      `DELETE account "${client.name}" (#${client.id})?\n\nThis permanently removes brokers, credentials, and trading settings.`,
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

  const rows = data || [];
  const focused = rows.find((c) => c.id === focusId) || null;
  const focusAccounts = focused ? accounts.filter((a) => a.client_id === focused.id) : [];
  const online = rows.filter((c) => c.enabled).length;
  const panelOn = rows.filter((c) => c.access_enabled && c.has_access_code).length;
  const robotsOn = rows.filter((c) => c.robot_status === 'RUNNING').length;
  const shareUrl =
    import.meta.env.VITE_CLIENT_PANEL_URL ||
    'Double-click VS.bat → copy https://….trycloudflare.com from that window';

  return (
    <div className="cl-shell">
      <header className="cl-top">
        <div>
          <div className="robot-arena-kicker">VS SYSTEM // CLIENT DESKS</div>
          <h1 className="cl-title">CLIENTS</h1>
        </div>
        <div className="cl-stats">
          <div className="cl-stat">
            <span>TOTAL</span>
            <strong>{rows.length}</strong>
          </div>
          <div className="cl-stat">
            <span>ENABLED</span>
            <strong>{online}</strong>
          </div>
          <div className="cl-stat">
            <span>PANEL</span>
            <strong>{panelOn}</strong>
          </div>
          <div className="cl-stat">
            <span>ROBOTS</span>
            <strong>{robotsOn}</strong>
          </div>
        </div>
        <div className="cl-actions">
          <button
            type="button"
            className={`btn ${view === 'command' ? 'btn-primary' : ''}`}
            onClick={() => setView('command')}
          >
            ROSTER
          </button>
          <button
            type="button"
            className={`btn ${view === 'info' ? 'btn-primary' : ''}`}
            onClick={() => setView('info')}
          >
            INFO
          </button>
          <Link className="btn" to="/robot">
            ROBOT →
          </Link>
        </div>
      </header>

      {view === 'command' ? (
        <>
          <div className="cl-add">
            <input
              className="input"
              placeholder="Account / client name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreate();
              }}
            />
            <button className="btn btn-primary" onClick={() => void handleCreate()} disabled={submitting}>
              ADD CLIENT
            </button>
            {msg && <span className="cl-msg mono">{msg}</span>}
            {issuedCode && (
              <span className="cl-code mono">
                CODE #{issuedCode.client_id}: <strong>{issuedCode.code}</strong>
              </span>
            )}
          </div>

          <section className="cl-stage">
            <div className="cl-roster">
              {rows.length === 0 && <div className="empty-state">NO CLIENTS YET</div>}
              {rows.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`cl-row ${focusId === c.id ? 'active' : ''} ${c.enabled ? 'on' : 'off'}`}
                  onClick={() => setFocusId(c.id)}
                >
                  <span className="mono">#{c.id}</span>
                  <strong>{c.name}</strong>
                  <span className={`badge ${c.enabled ? 'badge-healthy' : 'badge-unhealthy'}`}>
                    {c.enabled ? 'ON' : 'OFF'}
                  </span>
                  <span
                    className={`badge ${
                      c.access_enabled && c.has_access_code ? 'badge-healthy' : 'badge-unhealthy'
                    }`}
                  >
                    {c.access_enabled && c.has_access_code ? 'PANEL' : 'NO ACCESS'}
                  </span>
                  <span
                    className={`badge ${
                      c.robot_status === 'RUNNING' ? 'badge-healthy' : 'badge-unhealthy'
                    }`}
                  >
                    {c.robot_status || 'STOPPED'}
                  </span>
                  <span className="mono cl-row-trade">
                    {c.live_trade ? `${c.live_trade.trade_type} ${c.live_trade.lot_size}` : '—'}
                  </span>
                </button>
              ))}
            </div>

            <div className="cl-focus">
              {focused ? (
                <>
                  <div className="robot-arena-kicker">FOCUS CLIENT</div>
                  <div className="cl-focus-name">
                    #{focused.id} · {focused.name}
                  </div>
                  <div className="cl-focus-grid mono">
                    <div>
                      <span>MARKET</span>
                      <strong>
                        {focused.panel_display_name || focused.panel_epic || '—'}
                        {focused.panel_lot_size != null ? ` / ${focused.panel_lot_size}` : ''}
                      </strong>
                    </div>
                    <div>
                      <span>LAST SEEN</span>
                      <strong>
                        {focused.last_seen_at
                          ? new Date(focused.last_seen_at).toLocaleString()
                          : '—'}
                      </strong>
                    </div>
                    <div>
                      <span>BROKER</span>
                      <select
                        className="input"
                        value={focused.preferred_broker_account_id ?? focused.account_id ?? ''}
                        onChange={(e) =>
                          void handlePreferredAccount(
                            focused,
                            e.target.value === '' ? '' : Number(e.target.value),
                          )
                        }
                      >
                        <option value="">Auto / first</option>
                        {focusAccounts.map((a) => (
                          <option key={a.account_id} value={a.account_id}>
                            #{a.account_id} · {a.display_name} ({a.environment})
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="cl-focus-actions">
                    <button className="btn" type="button" onClick={() => void handleToggle(focused)}>
                      {focused.enabled ? 'DISABLE' : 'ENABLE'}
                    </button>
                    <button
                      className="btn btn-go"
                      type="button"
                      onClick={() => void handleGenerateCode(focused)}
                    >
                      {focused.has_access_code ? 'RESET CODE' : 'GENERATE CODE'}
                    </button>
                    <button
                      className="btn"
                      type="button"
                      onClick={() => void handleAccessToggle(focused)}
                    >
                      {focused.access_enabled ? 'ACCESS OFF' : 'ACCESS ON'}
                    </button>
                    <button className="btn" type="button" onClick={() => void handleRevoke(focused)}>
                      REVOKE
                    </button>
                    <button
                      className="btn btn-stop"
                      type="button"
                      disabled={focused.robot_status !== 'RUNNING'}
                      onClick={() => void handleAdminStop(focused)}
                    >
                      STOP
                    </button>
                    <button
                      className="btn btn-danger"
                      type="button"
                      onClick={() => void handleDelete(focused)}
                    >
                      DELETE
                    </button>
                  </div>
                  <button type="button" className="btn cl-more" onClick={() => setView('info')}>
                    SHARE URL / NOTES → INFO
                  </button>
                </>
              ) : (
                <div className="empty-state">SELECT A CLIENT</div>
              )}
            </div>
          </section>
        </>
      ) : (
        <section className="cl-info">
          <div className="cl-info-panel">
            <div className="section-title">Client panel URL (share this)</div>
            <p className="mono cl-info-url">{shareUrl}</p>
            <p className="cl-info-note">
              Client is <strong>not</strong> on your Wi‑Fi — do not send a 192.168.x.x IP. Keep{' '}
              <code>VS.bat</code> open, send the https tunnel link + access code. Admin preview:{' '}
              <Link to="/client">/client</Link>
            </p>
          </div>
          <div className="cl-info-panel">
            <div className="section-title">How access works</div>
            <ul className="cl-info-list mono">
              <li>GENERATE CODE → rāda kodu vienreiz</li>
              <li>ACCESS ON → atļauj Client Panel</li>
              <li>REVOKE → noņem paneli</li>
              <li>STOP → admin stop robotam</li>
            </ul>
          </div>
          <div className="cl-info-panel">
            <div className="section-title">Roster snapshot</div>
            <div className="mono cl-info-note">
              {rows.length} clients · {online} enabled · {panelOn} panel · {robotsOn} robots running
            </div>
            {issuedCode && (
              <div className="cl-code mono" style={{ marginTop: 10 }}>
                LAST CODE #{issuedCode.client_id}: <strong>{issuedCode.code}</strong>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
