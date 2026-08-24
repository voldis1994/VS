import { useCallback, useEffect, useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { apiFetch } from '../../hooks/useApi';

type Candidate = {
  epic: string;
  display_name: string;
  category: string;
  regime: string;
  direction: string | null;
  setup: string | null;
  score: number;
  reason: string;
  mid: number | null;
  skipped?: string | null;
};

type Status = {
  running: boolean;
  account_id: number | null;
  client_name: string | null;
  universe: Array<{ epic: string; display_name: string; category: string }>;
  candidates: Candidate[];
  pick: Candidate | null;
  last_scan_at: string | null;
  last_fire_at: string | null;
  last_fire_detail: string | null;
  last_error: string | null;
  fire_cooldown_ms: number;
  min_score: number;
};

type Acct = {
  account_id: number;
  client_id: number;
  client_name: string;
  environment: string;
  display_name?: string;
};

export function MultiMarketView() {
  const [status, setStatus] = useState<Status | null>(null);
  const [accounts, setAccounts] = useState<Acct[]>([]);
  const [accountId, setAccountId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const s = await apiFetch<Status>('/api/multi-market');
      setStatus(s);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sync failed');
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const rows = await apiFetch<Acct[]>('/api/trading/accounts');
        const list = Array.isArray(rows) ? rows : [];
        setAccounts(list);
        if (list[0]) setAccountId(list[0].account_id);
      } catch {
        /* ignore */
      }
      await refresh();
    })();
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
  }, [refresh]);

  async function start() {
    if (!accountId) return;
    setBusy(true);
    try {
      await apiFetch('/api/multi-market/start', {
        method: 'POST',
        body: JSON.stringify({ account_id: accountId }),
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Start failed');
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    try {
      await apiFetch('/api/multi-market/stop', { method: 'POST' });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Stop failed');
    } finally {
      setBusy(false);
    }
  }

  const running = status?.running;
  const pick = status?.pick;

  return (
    <div className="cmd-page">
      <PageHeader
        title="Multi-market"
        subtitle="One brain · popular universe · best setup wins · EntryReady to clients"
      />

      {error && <div className="cmd-banner err">{error}</div>}
      {status?.last_error && <div className="cmd-banner err">{status.last_error}</div>}

      <section className="cmd-panel" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
          <label style={{ display: 'grid', gap: 4, minWidth: 220 }}>
            <span className="cmd-muted">Scan account (Capital catalog)</span>
            <select
              value={accountId ?? ''}
              onChange={(e) => setAccountId(Number(e.target.value) || null)}
              disabled={!!running}
            >
              {accounts.map((a) => (
                <option key={a.account_id} value={a.account_id}>
                  {a.client_name} · {a.environment} · #{a.account_id}
                </option>
              ))}
            </select>
          </label>
          {!running ? (
            <button className="cmd-btn primary" disabled={busy || !accountId} onClick={() => void start()}>
              Start selector
            </button>
          ) : (
            <button className="cmd-btn danger" disabled={busy} onClick={() => void stop()}>
              Stop
            </button>
          )}
        </div>
        <p className="cmd-muted" style={{ marginTop: 10, marginBottom: 0 }}>
          Clients need <strong>panel multi-market</strong> ON (or matching epic) + RUNNING to receive picks.
          Fire cooldown {status?.fire_cooldown_ms ? status.fire_cooldown_ms / 1000 : 30}s · min score{' '}
          {status?.min_score ?? 78}.
        </p>
      </section>

      <section className="cmd-panel" style={{ marginBottom: 16 }}>
        <div className="cmd-kicker">STATUS</div>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginTop: 8 }}>
          <div>
            <div className="cmd-muted">State</div>
            <strong>{running ? 'SCANNING' : 'STOPPED'}</strong>
          </div>
          <div>
            <div className="cmd-muted">Feed client</div>
            <strong>{status?.client_name || '—'}</strong>
          </div>
          <div>
            <div className="cmd-muted">Universe</div>
            <strong>{status?.universe?.length ?? 0}</strong>
          </div>
          <div>
            <div className="cmd-muted">Last scan</div>
            <strong>{status?.last_scan_at ? new Date(status.last_scan_at).toLocaleTimeString() : '—'}</strong>
          </div>
        </div>
        {pick && (
          <div style={{ marginTop: 14, padding: '10px 12px', background: 'rgba(0,180,140,0.12)' }}>
            <div className="cmd-kicker">PICK</div>
            <strong>
              {pick.direction} {pick.display_name}
            </strong>{' '}
            · score {pick.score} · {pick.regime} · {pick.setup}
            <div className="cmd-muted">{pick.reason}</div>
          </div>
        )}
        {status?.last_fire_detail && (
          <div className="cmd-muted" style={{ marginTop: 8 }}>
            Last fire: {status.last_fire_detail}
            {status.last_fire_at ? ` · ${new Date(status.last_fire_at).toLocaleTimeString()}` : ''}
          </div>
        )}
      </section>

      <section className="cmd-panel">
        <div className="cmd-kicker">CANDIDATES</div>
        <table className="cmd-table" style={{ width: '100%', marginTop: 8 }}>
          <thead>
            <tr>
              <th>Market</th>
              <th>Regime</th>
              <th>Setup</th>
              <th>Score</th>
              <th>Mid</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {(status?.candidates || []).map((c) => (
              <tr key={c.epic}>
                <td>
                  <strong>{c.display_name}</strong>
                  <div className="cmd-muted">{c.epic}</div>
                </td>
                <td>{c.regime}</td>
                <td>
                  {c.direction || '—'} {c.setup || ''}
                </td>
                <td>{c.score}</td>
                <td>{c.mid != null ? c.mid.toFixed(2) : '—'}</td>
                <td className="cmd-muted">{c.skipped || c.reason}</td>
              </tr>
            ))}
            {!status?.candidates?.length && (
              <tr>
                <td colSpan={6} className="cmd-muted">
                  No scan yet — start selector.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
