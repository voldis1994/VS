import { useEffect, useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { apiFetch, useApi } from '../../hooks/useApi';

type TradingAccount = {
  account_id: number;
  client_name: string;
  display_name: string;
  environment: string;
  capital_market_count?: number;
};

type InstrumentRow = {
  instrument_id: number;
  epic?: string;
  symbol: string;
  display_name: string;
  enabled?: boolean;
  lot_size?: number;
};

export function TradingView() {
  const { data: accounts, error, loading, refresh } = useApi<TradingAccount[]>('/api/trading/accounts');
  const [accountId, setAccountId] = useState<number | null>(null);
  const [instruments, setInstruments] = useState<InstrumentRow[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!accounts?.length) return;
    setAccountId((p) => (p && accounts.some((a) => a.account_id === p) ? p : accounts[0]!.account_id));
  }, [accounts]);

  useEffect(() => {
    if (!accountId) return;
    void apiFetch<InstrumentRow[]>(`/api/trading/accounts/${accountId}/instruments`)
      .then(setInstruments)
      .catch(() => setInstruments([]));
  }, [accountId]);

  const syncAccounts = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await apiFetch<{ synced_accounts: number }>('/api/trading/accounts/sync', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setMsg(`Synced ${res.synced_accounts} accounts`);
      refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Sync failed');
    } finally {
      setBusy(false);
    }
  };

  const pullMarkets = async () => {
    if (!accountId) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await apiFetch<{ count: number }>(
        `/api/trading/accounts/${accountId}/pull-capital-markets`,
        { method: 'POST', body: JSON.stringify({}) },
      );
      setMsg(`Pulled ${res.count} markets`);
      const rows = await apiFetch<InstrumentRow[]>(`/api/trading/accounts/${accountId}/instruments`);
      setInstruments(rows);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Pull failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        kicker="VS SYSTEM // EXECUTION"
        title="Trading"
        stats={[{ label: 'Accounts', value: accounts?.length ?? 0 }]}
        actions={
          <>
            <button className="cmd-btn" type="button" disabled={busy} onClick={() => void syncAccounts()}>
              Sync accounts
            </button>
            <button className="cmd-btn cmd-btn--primary" type="button" disabled={busy || !accountId} onClick={() => void pullMarkets()}>
              Pull Capital markets
            </button>
          </>
        }
      />
      {loading && <div className="cmd-banner cmd-banner--busy">Loading…</div>}
      {error && <div className="cmd-banner cmd-banner--err">{error}</div>}
      {msg && <div className="cmd-banner cmd-banner--ok">{msg}</div>}

      <section className="cmd-panel" style={{ marginBottom: '1rem' }}>
        <div className="cmd-section-title">Account</div>
        <select
          className="cmd-select"
          style={{ maxWidth: 360 }}
          value={accountId ?? ''}
          onChange={(e) => setAccountId(Number(e.target.value))}
        >
          {(accounts || []).map((a) => (
            <option key={a.account_id} value={a.account_id}>
              {a.client_name} · {a.display_name} ({a.environment}) · {a.capital_market_count ?? 0} mkts
            </option>
          ))}
        </select>
      </section>

      <section className="cmd-panel">
        <div className="cmd-section-title">Instruments ({instruments.length})</div>
        <div className="cmd-table-wrap">
          <table className="cmd-table">
            <thead>
              <tr>
                <th>Epic</th>
                <th>Name</th>
                <th>Lot</th>
                <th>Enabled</th>
              </tr>
            </thead>
            <tbody>
              {instruments.slice(0, 100).map((r) => (
                <tr key={r.instrument_id}>
                  <td className="mono">{r.epic || r.symbol}</td>
                  <td>{r.display_name}</td>
                  <td className="mono">{r.lot_size ?? '—'}</td>
                  <td>
                    <span className={`cmd-badge ${r.enabled !== false ? 'cmd-badge--ok' : 'cmd-badge--bad'}`}>
                      {r.enabled !== false ? 'YES' : 'NO'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
