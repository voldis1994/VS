import { useEffect, useMemo, useState } from 'react';
import { useApi, apiFetch } from '../hooks/useApi';

interface TradingAccount {
  account_id: number;
  display_name: string;
  broker_name: string;
  environment: string;
  client_name: string;
  identifier: string | null;
}

interface InstrumentRow {
  instrument_id: number;
  symbol: string;
  display_name: string;
  category: string;
  min_lot: number;
  max_lot: number;
  lot_step: number;
  lot_size: number;
  enabled: boolean;
  trading_enabled: boolean;
  configured: boolean;
}

export function TradingPage() {
  const { data: accounts, error, loading, refresh } = useApi<TradingAccount[]>('/api/trading/accounts');
  const [accountId, setAccountId] = useState<number | null>(null);
  const [instruments, setInstruments] = useState<InstrumentRow[]>([]);
  const [instError, setInstError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [category, setCategory] = useState('all');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!accounts || accounts.length === 0) {
      setAccountId(null);
      return;
    }
    if (!accountId || !accounts.some((a) => a.account_id === accountId)) {
      setAccountId(accounts[0].account_id);
    }
  }, [accounts, accountId]);

  const loadInstruments = async (id: number) => {
    setInstError(null);
    try {
      const rows = await apiFetch<InstrumentRow[]>(`/api/trading/accounts/${id}/instruments`);
      setInstruments(rows);
    } catch (e) {
      setInstError(e instanceof Error ? e.message : 'Failed to load instruments');
    }
  };

  useEffect(() => {
    if (accountId) void loadInstruments(accountId);
  }, [accountId]);

  const filtered = useMemo(() => {
    return instruments.filter((i) => {
      if (category !== 'all' && i.category !== category) return false;
      if (!filter.trim()) return true;
      const q = filter.toLowerCase();
      return i.symbol.toLowerCase().includes(q) || i.display_name.toLowerCase().includes(q);
    });
  }, [instruments, filter, category]);

  const syncAccounts = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await apiFetch<{ synced_accounts: number }>('/api/trading/accounts/sync', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setMsg(`Synced ${res.synced_accounts} account(s). Markets + lot size ready below.`);
      refresh();
      if (accountId) await loadInstruments(accountId);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Sync failed');
    } finally {
      setBusy(false);
    }
  };

  const updateRow = async (
    instrumentId: number,
    patch: Partial<Pick<InstrumentRow, 'lot_size' | 'enabled' | 'trading_enabled'>>
  ) => {
    if (!accountId) return;
    setBusy(true);
    setMsg(null);
    try {
      await apiFetch(`/api/trading/accounts/${accountId}/instruments/${instrumentId}`, {
        method: 'PUT',
        body: JSON.stringify(patch),
      });
      await loadInstruments(accountId);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Update failed');
    } finally {
      setBusy(false);
    }
  };

  const enableAllVisibleTrading = async (on: boolean) => {
    if (!accountId) return;
    setBusy(true);
    setMsg(null);
    try {
      for (const row of filtered) {
        await apiFetch(`/api/trading/accounts/${accountId}/instruments/${row.instrument_id}`, {
          method: 'PUT',
          body: JSON.stringify({ enabled: true, trading_enabled: on, lot_size: row.lot_size }),
        });
      }
      setMsg(on ? 'Auto-trade ON for filtered markets' : 'Auto-trade OFF for filtered markets');
      await loadInstruments(accountId);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Bulk update failed');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="empty-state">Loading trading accounts...</div>;
  if (error) return <div className="error-state">{error}</div>;

  return (
    <div>
      <h1 className="page-title">Trading</h1>
      <p className="page-subtitle">
        Markets · lot size · auto-trade // LIVE requires Brokers Live + Settings gate
      </p>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="section-title">Account</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <select
            className="input"
            style={{ maxWidth: 420 }}
            value={accountId ?? ''}
            onChange={(e) => setAccountId(parseInt(e.target.value, 10))}
          >
            {(accounts || []).length === 0 && <option value="">No accounts — click Sync</option>}
            {(accounts || []).map((a) => (
              <option key={a.account_id} value={a.account_id}>
                #{a.account_id} {a.client_name} / {a.broker_name} ({a.environment})
              </option>
            ))}
          </select>
          <button className="btn btn-primary" onClick={syncAccounts} disabled={busy}>
            Sync accounts & markets
          </button>
        </div>
        {msg && (
          <p
            style={{
              marginTop: 8,
              fontSize: 13,
              fontFamily: 'var(--font-mono)',
              color: msg.toLowerCase().includes('sync') || msg.toLowerCase().includes('ready')
                ? 'var(--accent)'
                : 'var(--danger)',
            }}
          >
            {msg}
          </p>
        )}
        {(accounts || []).length === 0 && (
          <p className="error-state" style={{ marginTop: 8 }}>
            No broker account yet. Save a Capital.com Live connection under Brokers, then Sync.
          </p>
        )}
      </div>

      {accountId && (
        <div className="card">
          <div className="section-title">Markets & lot size</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            <input
              className="input"
              style={{ maxWidth: 240 }}
              placeholder="Search symbol..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <select className="input" style={{ maxWidth: 160 }} value={category}
              onChange={(e) => setCategory(e.target.value)}>
              <option value="all">All categories</option>
              <option value="fx">FX</option>
              <option value="metals">Metals</option>
              <option value="energy">Energy</option>
              <option value="indices">Indices</option>
              <option value="crypto">Crypto</option>
            </select>
            <button className="btn" disabled={busy} onClick={() => enableAllVisibleTrading(true)}>
              Auto-trade ON (filtered)
            </button>
            <button className="btn" disabled={busy} onClick={() => enableAllVisibleTrading(false)}>
              Auto-trade OFF (filtered)
            </button>
          </div>
          {instError && <div className="error-state">{instError}</div>}
          <div style={{ overflow: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Market</th>
                  <th>Category</th>
                  <th>Watch</th>
                  <th>Lot size</th>
                  <th>Auto-trade</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => (
                  <tr key={row.instrument_id}>
                    <td>
                      <strong>{row.symbol}</strong>
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{row.display_name}</div>
                    </td>
                    <td>{row.category}</td>
                    <td>
                      <input
                        type="checkbox"
                        checked={row.enabled}
                        disabled={busy}
                        onChange={(e) => updateRow(row.instrument_id, { enabled: e.target.checked })}
                      />
                    </td>
                    <td>
                      <input
                        className="input"
                        style={{ maxWidth: 110 }}
                        type="number"
                        step={row.lot_step}
                        min={row.min_lot}
                        max={row.max_lot}
                        value={row.lot_size}
                        disabled={busy}
                        onChange={(e) => {
                          const v = parseFloat(e.target.value);
                          setInstruments((prev) =>
                            prev.map((p) =>
                              p.instrument_id === row.instrument_id ? { ...p, lot_size: v } : p
                            )
                          );
                        }}
                        onBlur={(e) => {
                          const v = parseFloat(e.target.value);
                          if (!Number.isFinite(v)) return;
                          void updateRow(row.instrument_id, {
                            lot_size: v,
                            enabled: true,
                          });
                        }}
                      />
                    </td>
                    <td>
                      <button
                        className={`btn ${row.trading_enabled ? 'btn-danger' : 'btn-primary'}`}
                        disabled={busy}
                        onClick={() =>
                          updateRow(row.instrument_id, {
                            enabled: true,
                            trading_enabled: !row.trading_enabled,
                            lot_size: row.lot_size,
                          })
                        }
                      >
                        {row.trading_enabled ? 'TRADING ON' : 'OFF'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filtered.length === 0 && <div className="empty-state">No markets match filter</div>}
        </div>
      )}
    </div>
  );
}
