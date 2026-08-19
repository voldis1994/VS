import { useEffect, useMemo, useState } from 'react';
import { useApi, apiFetch } from '../hooks/useApi';
import { openRobotWindow } from './RobotDeskPage';

interface TradingAccount {
  account_id: number;
  display_name: string;
  broker_name: string;
  environment: string;
  client_name: string;
  identifier: string | null;
  capital_market_count?: number;
}

interface InstrumentRow {
  instrument_id: number;
  epic?: string;
  symbol: string;
  display_name: string;
  category: string;
  instrument_type?: string;
  min_lot: number;
  max_lot: number;
  lot_step: number;
  lot_size: number;
  enabled: boolean;
  trading_enabled: boolean;
  configured: boolean;
  source?: 'capital_com' | 'local_fallback';
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
  const [msgOk, setMsgOk] = useState(true);
  const [orderEpic, setOrderEpic] = useState('');
  const [orderSize, setOrderSize] = useState('0.1');
  const [orderBusy, setOrderBusy] = useState(false);

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

  useEffect(() => {
    if (!instruments.length) {
      setOrderEpic('');
      return;
    }
    setOrderEpic((prev) =>
      prev && instruments.some((i) => (i.epic || i.symbol) === prev)
        ? prev
        : instruments[0].epic || instruments[0].symbol,
    );
    if (!orderSize || orderSize === '0.1') {
      setOrderSize(String(instruments[0].lot_size || instruments[0].min_lot || 0.1));
    }
  }, [instruments]);

  const categories = useMemo(() => {
    const set = new Set(instruments.map((i) => i.category).filter(Boolean));
    return ['all', ...[...set].sort()];
  }, [instruments]);

  const filtered = useMemo(() => {
    return instruments.filter((i) => {
      if (category !== 'all' && i.category !== category) return false;
      if (!filter.trim()) return true;
      const q = filter.toLowerCase();
      return (
        i.symbol.toLowerCase().includes(q) ||
        i.display_name.toLowerCase().includes(q) ||
        (i.epic || '').toLowerCase().includes(q)
      );
    });
  }, [instruments, filter, category]);

  const source = instruments[0]?.source || (instruments.length ? 'capital_com' : 'empty');
  const selected = accounts?.find((a) => a.account_id === accountId);

  const syncAccounts = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await apiFetch<{ synced_accounts: number }>('/api/trading/accounts/sync', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setMsgOk(true);
      setMsg(`Synced ${res.synced_accounts} account(s).`);
      refresh();
      if (accountId) await loadInstruments(accountId);
    } catch (e) {
      setMsgOk(false);
      setMsg(e instanceof Error ? e.message : 'Sync failed');
    } finally {
      setBusy(false);
    }
  };

  const pullCapitalMarkets = async () => {
    if (!accountId) return;
    setBusy(true);
    setMsgOk(true);
    setMsg(
      'Pulling ALL Capital.com markets (real epics + names). This can take 1–3 minutes — do not close the tab...'
    );
    try {
      const res = await apiFetch<{ count: number; sample?: Array<{ epic: string; name: string }> }>(
        `/api/trading/accounts/${accountId}/pull-capital-markets`,
        { method: 'POST', body: JSON.stringify({}) }
      );
      setMsgOk(true);
      setMsg(
        `Loaded ${res.count} Capital.com markets` +
          (res.sample?.length
            ? ` · e.g. ${res.sample.map((s) => s.name).slice(0, 4).join(', ')}`
            : '')
      );
      refresh();
      await loadInstruments(accountId);
    } catch (e) {
      setMsgOk(false);
      setMsg(e instanceof Error ? e.message : 'Pull Capital.com markets failed');
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
      setMsgOk(false);
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
      setMsgOk(true);
      setMsg(on ? 'Auto-trade ON for filtered markets' : 'Auto-trade OFF for filtered markets');
      await loadInstruments(accountId);
    } catch (e) {
      setMsgOk(false);
      setMsg(e instanceof Error ? e.message : 'Bulk update failed');
    } finally {
      setBusy(false);
    }
  };

  const startRobotFor = (epic: string, lot: number, displayName: string) => {
    if (!accountId || !epic) {
      setMsgOk(false);
      setMsg('Izvēlies account + tirgu');
      return;
    }
    openRobotWindow({
      accountId,
      epic,
      lot,
      name: displayName,
    });
    setMsgOk(true);
    setMsg(`Robot board · ${displayName} · lot ${lot}`);
  };

  const placeOrder = async (direction: 'BUY' | 'SELL') => {
    if (!accountId) return;
    setOrderBusy(true);
    setMsg(null);
    try {
      const res = await apiFetch<{ detail: string; deal_reference?: string }>(
        `/api/trading/accounts/${accountId}/orders`,
        {
          method: 'POST',
          body: JSON.stringify({
            epic: orderEpic.trim(),
            direction,
            size: Number(orderSize),
          }),
        },
      );
      setMsgOk(true);
      setMsg(res.detail + (res.deal_reference ? ` · ${res.deal_reference}` : ''));
    } catch (e) {
      setMsgOk(false);
      setMsg(e instanceof Error ? e.message : 'Order failed');
    } finally {
      setOrderBusy(false);
    }
  };

  if (loading) return <div className="empty-state">LOADING TRADE DESK...</div>;
  if (error) return <div className="error-state">{error}</div>;

  return (
    <div>
      <h1 className="page-title">Trading</h1>
      <p className="page-subtitle">
        Only real Capital.com market names · lot size · LIVE BUY/SELL
      </p>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="section-title">Account</div>
        <div className="actions">
          <select
            className="input"
            style={{ maxWidth: 420 }}
            value={accountId ?? ''}
            onChange={(e) => setAccountId(parseInt(e.target.value, 10))}
          >
            {(accounts || []).length === 0 && <option value="">No accounts — Sync first</option>}
            {(accounts || []).map((a) => (
              <option key={a.account_id} value={a.account_id}>
                #{a.account_id} {a.client_name} / {a.broker_name} ({a.environment})
                {typeof a.capital_market_count === 'number' ? ` · ${a.capital_market_count} markets` : ''}
              </option>
            ))}
          </select>
          <button className="btn" onClick={syncAccounts} disabled={busy}>
            Sync accounts
          </button>
          <button className="btn btn-primary" onClick={pullCapitalMarkets} disabled={busy || !accountId}>
            PULL CAPITAL
          </button>
        </div>
        {msg && (
          <p
            style={{
              marginTop: 10,
              fontSize: 13,
              fontFamily: 'var(--font-mono)',
              color: msgOk ? 'var(--accent)' : 'var(--danger)',
            }}
          >
            {msg}
          </p>
        )}
        {source === 'empty' && accountId && (
          <p className="error-state" style={{ marginTop: 10 }}>
            Nav Capital.com tirgu. Spied <strong>PULL CAPITAL</strong> — bez tā
            rādās tukšs (fake katalogs izslēgts).
          </p>
        )}
        {source === 'capital_com' && (
          <p style={{ marginTop: 10, fontSize: 12, color: 'var(--success)', fontFamily: 'var(--font-mono)' }}>
            Source: Capital.com · {instruments.length} real markets
          </p>
        )}
      </div>

      {accountId && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="section-title">LIVE ORDER (Capital.com name)</div>
          <p className="hint-line" style={{ marginBottom: 10 }}>
            Izvēlies tirgu no ielādētā Capital.com kataloga (īsts display name). Brokers Test = OK.
          </p>
          <div className="actions">
            <select
              className="input"
              style={{ maxWidth: 420 }}
              value={orderEpic}
              onChange={(e) => setOrderEpic(e.target.value)}
              disabled={!instruments.length}
            >
              {instruments.length === 0 && <option value="">Pull markets first</option>}
              {instruments.map((i) => (
                <option key={i.instrument_id} value={i.epic || i.symbol}>
                  {i.display_name} · {i.epic || i.symbol}
                </option>
              ))}
            </select>
            <input
              className="input"
              style={{ maxWidth: 120 }}
              placeholder="Size"
              value={orderSize}
              onChange={(e) => setOrderSize(e.target.value)}
            />
            <button
              className="btn btn-go"
              disabled={orderBusy || !orderEpic.trim()}
              onClick={() => void placeOrder('BUY')}
            >
              BUY
            </button>
            <button
              className="btn btn-stop"
              disabled={orderBusy || !orderEpic.trim()}
              onClick={() => void placeOrder('SELL')}
            >
              SELL
            </button>
            <button
              className="btn btn-primary"
              disabled={!orderEpic.trim() || !accountId}
              onClick={() => {
                const row = instruments.find((i) => (i.epic || i.symbol) === orderEpic);
                startRobotFor(
                  orderEpic.trim(),
                  Number(orderSize) || row?.lot_size || 0.1,
                  row?.display_name || orderEpic,
                );
              }}
            >
              START ROBOT
            </button>
          </div>
          <p className="hint-line" style={{ marginTop: 8 }}>
            START ROBOT atver fullscreen Robot Desk šim tirgum (ONE TRADE ONLY). Tabula FLAG nav
            robots — spied START ROBOT rindā vai šeit augšā.
          </p>
        </div>
      )}

      {accountId && (
        <div className="card">
          <div className="section-title">Markets & lot size</div>
          <div className="actions" style={{ marginBottom: 12 }}>
            <input
              className="input"
              style={{ maxWidth: 260 }}
              placeholder="Search Capital.com name / epic..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <select
              className="input"
              style={{ maxWidth: 180 }}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c === 'all' ? 'All categories' : c}
                </option>
              ))}
            </select>
            <button className="btn" disabled={busy} onClick={() => enableAllVisibleTrading(true)}>
              Auto-trade ON (filtered)
            </button>
            <button className="btn" disabled={busy} onClick={() => enableAllVisibleTrading(false)}>
              Auto-trade OFF (filtered)
            </button>
            <span className="mono" style={{ color: 'var(--text-secondary)' }}>
              showing {filtered.length} / {instruments.length}
            </span>
          </div>
          {instError && <div className="error-state">{instError}</div>}
          <div className="table-wrap" style={{ maxHeight: '65vh' }}>
            <table>
              <thead>
                <tr>
                  <th>Epic</th>
                  <th>Capital.com name</th>
                  <th>Category</th>
                  <th>Watch</th>
                  <th>Lot size</th>
                  <th>Flag</th>
                  <th>Robot</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => (
                  <tr key={row.instrument_id}>
                    <td className="mono">{row.epic || row.symbol}</td>
                    <td>
                      <strong>{row.display_name}</strong>
                      {row.instrument_type && (
                        <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                          {row.instrument_type}
                        </div>
                      )}
                    </td>
                    <td className="mono">{row.category}</td>
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
                          void updateRow(row.instrument_id, { lot_size: v, enabled: true });
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
                        {row.trading_enabled ? 'FLAG ON' : 'FLAG OFF'}
                      </button>
                    </td>
                    <td>
                      <button
                        className="btn btn-go"
                        disabled={busy || !accountId}
                        onClick={() =>
                          startRobotFor(row.epic || row.symbol, row.lot_size, row.display_name)
                        }
                      >
                        START ROBOT
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filtered.length === 0 && <div className="empty-state">NO MARKETS MATCH FILTER</div>}
        </div>
      )}
    </div>
  );
}
