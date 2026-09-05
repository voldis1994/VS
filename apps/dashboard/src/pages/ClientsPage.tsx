import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi, apiFetch } from '../hooks/useApi';
import { SearchableSelect } from '../components/SearchableSelect';

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
  broker_name?: string;
  identifier?: string | null;
  capital_market_count?: number;
}

interface MarketRow {
  instrument_id: number;
  epic?: string;
  symbol: string;
  display_name: string;
  min_lot: number;
  max_lot: number;
  lot_step: number;
  lot_size: number;
}

function accountLabel(a: TradingAccount): string {
  const broker = a.broker_name || 'broker';
  const idPart = a.identifier ? ` · ${a.identifier}` : '';
  const markets =
    a.capital_market_count != null ? ` · ${a.capital_market_count} markets` : '';
  return `#${a.account_id} · ${a.display_name} · ${broker}/${a.environment}${idPart}${markets}`;
}

export function ClientsPage() {
  const { data, error, loading, refresh } = useApi<ClientRow[]>('/api/clients');
  const [accounts, setAccounts] = useState<TradingAccount[]>([]);
  const [name, setName] = useState('');
  const [createAccountId, setCreateAccountId] = useState('');
  const [createEpic, setCreateEpic] = useState('');
  const [createLot, setCreateLot] = useState('');
  const [createMarkets, setCreateMarkets] = useState<MarketRow[]>([]);
  const [marketsLoading, setMarketsLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [issuedCode, setIssuedCode] = useState<{ client_id: number; code: string } | null>(null);
  const [rosterMarkets, setRosterMarkets] = useState<Record<number, MarketRow[]>>({});

  const loadAccounts = async () => {
    try {
      const rows = await apiFetch<TradingAccount[]>('/api/trading/accounts');
      setAccounts(rows || []);
    } catch {
      setAccounts([]);
    }
  };

  useEffect(() => {
    void loadAccounts();
  }, []);

  useEffect(() => {
    if (!createAccountId) {
      setCreateMarkets([]);
      setCreateEpic('');
      setCreateLot('');
      return;
    }
    let cancelled = false;
    setMarketsLoading(true);
    void apiFetch<MarketRow[]>(`/api/trading/accounts/${createAccountId}/instruments`)
      .then((rows) => {
        if (cancelled) return;
        setCreateMarkets(rows || []);
        setCreateEpic('');
        setCreateLot('');
      })
      .catch(() => {
        if (!cancelled) {
          setCreateMarkets([]);
          setCreateEpic('');
          setCreateLot('');
        }
      })
      .finally(() => {
        if (!cancelled) setMarketsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [createAccountId]);

  const accountOptions = useMemo(
    () =>
      accounts.map((a) => {
        const broker = a.broker_name || '';
        const aliases =
          broker === 'crypto_com'
            ? 'crypto.com cryptocom crypto exchange'
            : broker === 'capital_com'
              ? 'capital.com capitalcom capital'
              : '';
        return {
          value: String(a.account_id),
          label: accountLabel(a),
          searchText: `${a.display_name} ${broker} ${aliases} ${a.environment} ${a.identifier || ''} ${a.client_name} #${a.account_id}`,
        };
      }),
    [accounts]
  );

  const createMarketOptions = useMemo(
    () =>
      createMarkets.map((m) => ({
        value: m.epic || m.symbol,
        label: `${m.display_name} · ${m.epic || m.symbol}`,
        searchText: `${m.display_name} ${m.epic || ''} ${m.symbol}`,
      })),
    [createMarkets]
  );

  const handleCreateMarketPick = (epic: string) => {
    setCreateEpic(epic);
    const m = createMarkets.find((x) => (x.epic || x.symbol) === epic);
    if (m) setCreateLot(String(m.lot_size || m.min_lot || ''));
    else setCreateLot('');
  };

  const handleCreate = async () => {
    if (!name.trim()) return;
    setSubmitting(true);
    setMsg(null);
    try {
      const body: Record<string, unknown> = { name: name.trim() };
      if (createAccountId) {
        body.preferred_broker_account_id = Number(createAccountId);
      }
      if (createEpic) {
        body.panel_epic = createEpic;
        const m = createMarkets.find((x) => (x.epic || x.symbol) === createEpic);
        body.panel_display_name = m?.display_name || createEpic;
        if (createLot.trim()) body.panel_lot_size = Number(createLot);
        else if (m) body.panel_lot_size = m.min_lot;
      }
      await apiFetch('/api/clients', { method: 'POST', body: JSON.stringify(body) });
      setName('');
      setCreateAccountId('');
      setCreateEpic('');
      setCreateLot('');
      setCreateMarkets([]);
      setMsg('Client created — broker/market linked from the pool.');
      refresh();
      void loadAccounts();
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

  const ensureRosterMarkets = async (accountId: number) => {
    if (rosterMarkets[accountId]) return rosterMarkets[accountId];
    try {
      const rows = await apiFetch<MarketRow[]>(`/api/trading/accounts/${accountId}/instruments`);
      setRosterMarkets((prev) => ({ ...prev, [accountId]: rows || [] }));
      return rows || [];
    } catch {
      setRosterMarkets((prev) => ({ ...prev, [accountId]: [] }));
      return [];
    }
  };

  const handlePreferredAccount = async (client: ClientRow, accountId: number | '') => {
    setMsg(null);
    try {
      await apiFetch(`/api/clients/${client.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          preferred_broker_account_id: accountId === '' ? null : Number(accountId),
          panel_epic: null,
          panel_display_name: null,
          panel_lot_size: null,
        }),
      });
      if (accountId !== '') void ensureRosterMarkets(Number(accountId));
      refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Broker assign failed');
    }
  };

  const handleRosterMarket = async (client: ClientRow, epic: string) => {
    setMsg(null);
    const accountId = client.preferred_broker_account_id ?? client.account_id;
    if (!accountId) {
      setMsg('Pick a broker account first');
      return;
    }
    try {
      const markets = await ensureRosterMarkets(accountId);
      const m = markets.find((x) => (x.epic || x.symbol) === epic);
      await apiFetch(`/api/clients/${client.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          panel_epic: epic || null,
          panel_display_name: m?.display_name || null,
          panel_lot_size: m ? m.lot_size || m.min_lot : null,
        }),
      });
      refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Market assign failed');
    }
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
      void loadAccounts();
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
        Add brokers individually on Brokers. Here search & assign any available broker account +
        market when creating a client.
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
        <p style={{ fontSize: 12, opacity: 0.75, marginBottom: 12 }}>
          <strong>1)</strong> First add the broker on <Link to="/brokers">Brokers</Link> (Capital.com
          or Crypto.com) → Test OK.{' '}
          <strong>2)</strong> Then search it here. Searching “crypto.com” only finds a Crypto.com
          connection that already exists in the pool — it does not create one.
        </p>
        <div className="actions" style={{ flexWrap: 'wrap', alignItems: 'flex-end', gap: 10 }}>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Client name</span>
            <input
              className="input"
              placeholder="Account / client name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={{ minWidth: 200 }}
            />
          </label>
          <label style={{ display: 'grid', gap: 4, minWidth: 280, flex: 1 }}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              Broker account (all available)
            </span>
            <SearchableSelect
              options={accountOptions}
              value={createAccountId}
              onChange={setCreateAccountId}
              placeholder="Search brokers…"
              emptyLabel={
                accounts.length === 0
                  ? 'No brokers yet — open Brokers first'
                  : 'No broker selected'
              }
            />
          </label>
          <label style={{ display: 'grid', gap: 4, minWidth: 280, flex: 1 }}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              Market (search catalog)
            </span>
            <SearchableSelect
              options={createMarketOptions}
              value={createEpic}
              onChange={handleCreateMarketPick}
              placeholder="Search markets…"
              emptyLabel={
                !createAccountId
                  ? 'Pick broker first'
                  : marketsLoading
                    ? 'Loading markets…'
                    : createMarkets.length === 0
                      ? 'No markets — Trading → Pull ALL'
                      : 'No market selected'
              }
              disabled={!createAccountId || marketsLoading}
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Lot</span>
            <input
              className="input"
              placeholder="Lot"
              value={createLot}
              onChange={(e) => setCreateLot(e.target.value)}
              disabled={!createEpic}
              style={{ width: 100 }}
            />
          </label>
          <button
            className="btn btn-primary"
            onClick={() => void handleCreate()}
            disabled={submitting}
          >
            Add Client
          </button>
        </div>
        {msg && (
          <p style={{ marginTop: 10, fontFamily: 'var(--font-mono)', fontSize: 12 }}>{msg}</p>
        )}
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
                const preferredId = c.preferred_broker_account_id ?? c.account_id ?? '';
                const marketOpts = preferredId
                  ? (rosterMarkets[Number(preferredId)] || []).map((m) => ({
                      value: m.epic || m.symbol,
                      label: `${m.display_name} · ${m.epic || m.symbol}`,
                      searchText: `${m.display_name} ${m.epic || ''} ${m.symbol}`,
                    }))
                  : [];
                return (
                  <tr key={c.id}>
                    <td className="mono">#{c.id}</td>
                    <td>{c.name}</td>
                    <td>
                      <span className={`badge ${c.enabled ? 'badge-healthy' : 'badge-unhealthy'}`}>
                        {c.enabled ? 'ON' : 'OFF'}
                      </span>
                    </td>
                    <td>
                      <span
                        className={`badge ${
                          c.access_enabled && c.has_access_code
                            ? 'badge-healthy'
                            : 'badge-unhealthy'
                        }`}
                      >
                        {c.access_enabled && c.has_access_code ? 'PANEL' : 'NO ACCESS'}
                      </span>
                    </td>
                    <td style={{ minWidth: 220 }}>
                      <SearchableSelect
                        options={accountOptions}
                        value={
                          preferredId === '' || preferredId == null ? '' : String(preferredId)
                        }
                        onChange={(v) =>
                          void handlePreferredAccount(c, v === '' ? '' : Number(v))
                        }
                        placeholder="Search brokers…"
                        emptyLabel="Auto / first owned"
                      />
                    </td>
                    <td style={{ minWidth: 220 }}>
                      <SearchableSelect
                        options={marketOpts}
                        value={c.panel_epic || ''}
                        onChange={(v) => void handleRosterMarket(c, v)}
                        placeholder="Search markets…"
                        emptyLabel={
                          !preferredId
                            ? 'Pick broker first'
                            : marketOpts.length === 0
                              ? 'Open to load / pull markets'
                              : 'No market'
                        }
                        disabled={!preferredId}
                        onOpen={() => {
                          if (preferredId) void ensureRosterMarkets(Number(preferredId));
                        }}
                      />
                      {(c.panel_display_name || c.panel_epic) && (
                        <div className="mono" style={{ fontSize: 11, marginTop: 4, opacity: 0.7 }}>
                          {c.panel_display_name || c.panel_epic}
                          {c.panel_lot_size != null ? ` / ${c.panel_lot_size}` : ''}
                        </div>
                      )}
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
