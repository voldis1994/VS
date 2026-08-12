import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { EquityCurve, DailyBars } from '../components/Charts';
import { useDesk } from '../components/DeskContext';
import { apiFetch } from '../hooks/useApi';

type Position = {
  id: number;
  client_name?: string;
  account_name?: string;
  instrument_id?: number;
  symbol?: string;
  direction?: string;
  entry_price?: number;
  quantity?: number;
  unrealized_pnl?: number;
  status?: string;
};

type SystemEvent = {
  id?: number;
  event_type?: string;
  message?: string;
  created_at?: string;
  payload?: unknown;
};

function seedSeries(seed: number, len: number, base = 10000): number[] {
  const out: number[] = [];
  let v = base + (seed % 500);
  for (let i = 0; i < len; i++) {
    v += Math.sin(i / 2.4 + seed) * 40 + ((seed * (i + 3)) % 17) - 8;
    out.push(Math.max(100, v));
  }
  return out;
}

function seedBars(seed: number, len: number): number[] {
  return Array.from({ length: len }, (_, i) => {
    const n = Math.sin(i * 0.9 + seed) * 180 + ((seed * (i + 1)) % 90) - 40;
    return Math.round(n);
  });
}

export function OverviewPage() {
  const {
    status,
    clients,
    accounts,
    selectedClientId,
    selectedAccountId,
    setSelectedAccountId,
    refreshDesk,
  } = useDesk();

  const [positions, setPositions] = useState<Position[]>([]);
  const [events, setEvents] = useState<SystemEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [lotMode, setLotMode] = useState<'auto' | 'fixed'>('auto');
  const [baseLot, setBaseLot] = useState('0.10');
  const [maxLot, setMaxLot] = useState('1.00');
  const [allowedSymbols, setAllowedSymbols] = useState('');
  const [runnerOn, setRunnerOn] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        const [pos, ev] = await Promise.all([
          apiFetch<Position[]>('/api/positions').catch(() => [] as Position[]),
          apiFetch<SystemEvent[]>('/api/system/events').catch(() => [] as SystemEvent[]),
        ]);
        setPositions(pos);
        setEvents(ev.slice(0, 12));
      } catch {
        /* ignore */
      }
    };
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    setRunnerOn(Boolean(status?.live_enabled) && (status?.mode || '').toUpperCase() === 'LIVE');
  }, [status?.live_enabled, status?.mode]);

  const selectedAccount = accounts.find((a) => a.account_id === selectedAccountId) || null;
  const deskAccounts = useMemo(() => {
    if (!selectedClientId) return accounts;
    const filtered = accounts.filter((a) => a.client_id === selectedClientId);
    return filtered.length ? filtered : accounts;
  }, [accounts, selectedClientId]);

  const equitySeries = useMemo(
    () => seedSeries((selectedAccountId || 1) * 17 + accounts.length, 28, 11000),
    [selectedAccountId, accounts.length],
  );
  const dailySeries = useMemo(
    () => seedBars((selectedAccountId || 3) * 11 + (status?.today_executions || 0), 14),
    [selectedAccountId, status?.today_executions],
  );

  const totalMarkets = accounts.reduce((s, a) => s + (a.capital_market_count || 0), 0);
  const liveAccounts = accounts.filter((a) => a.environment === 'live').length;
  const floatingHint = dailySeries.reduce((s, v) => s + v, 0);
  const profitFactor =
    dailySeries.filter((v) => v > 0).reduce((s, v) => s + v, 0) /
      Math.max(1, Math.abs(dailySeries.filter((v) => v < 0).reduce((s, v) => s + v, 0))) || 0;

  const startRunner = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await apiFetch('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ live_trading_enabled: true, confirm_live: true }),
      });
      await apiFetch('/api/system/mode', {
        method: 'POST',
        body: JSON.stringify({ mode: 'LIVE' }),
      });
      setRunnerOn(true);
      setMsg('AI runner armed → LIVE gate ON + mode LIVE');
      refreshDesk();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Failed to start runner');
    } finally {
      setBusy(false);
    }
  };

  const stopRunner = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await apiFetch('/api/system/mode', {
        method: 'POST',
        body: JSON.stringify({ mode: 'PAPER' }),
      });
      setRunnerOn(false);
      setMsg('Runner stopped → mode PAPER');
      refreshDesk();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Failed to stop runner');
    } finally {
      setBusy(false);
    }
  };

  const accountPositions = selectedAccount
    ? positions.filter(
        (p) =>
          p.client_name === selectedAccount.client_name ||
          String(p.account_name || '') === selectedAccount.display_name,
      )
    : positions;

  return (
    <div className="main-dash">
      <div className="dash-head">
        <div>
          <h1 className="page-title">MAIN DASHBOARD</h1>
          <p className="page-subtitle">
            Prop desk control // accounts · risk · automation · live Capital.com
          </p>
        </div>
        {msg && <div className={msg.includes('Failed') ? 'error-state' : 'ok-state'}>{msg}</div>}
      </div>

      <div className="dash-grid dash-top">
        <section className="panel">
          <div className="section-title">OVERVIEW</div>
          <div className="metric-row">
            <div className="metric-box">
              <div className="label">Accounts</div>
              <div className="value">{accounts.length}</div>
            </div>
            <div className="metric-box">
              <div className="label">Clients</div>
              <div className="value">{clients.length}</div>
            </div>
            <div className="metric-box">
              <div className="label">Open trades</div>
              <div className="value">{status?.open_positions ?? 0}</div>
            </div>
            <div className="metric-box">
              <div className="label">Today fills</div>
              <div className="value pos">{status?.today_executions ?? 0}</div>
            </div>
            <div className="metric-box">
              <div className="label">Live accounts</div>
              <div className="value">{liveAccounts}</div>
            </div>
            <div className="metric-box">
              <div className="label">Markets cached</div>
              <div className="value">{totalMarkets.toLocaleString()}</div>
            </div>
            <div className="metric-box">
              <div className="label">Profit factor*</div>
              <div className="value">{profitFactor.toFixed(2)}</div>
            </div>
            <div className="metric-box">
              <div className="label">Floating hint*</div>
              <div className={`value ${floatingHint >= 0 ? 'pos' : 'neg'}`}>
                {floatingHint >= 0 ? '+' : ''}
                {floatingHint.toLocaleString()}
              </div>
            </div>
          </div>
          <div className="hint-line">* Curve / bars are desk visuals until equity history feed is wired.</div>
        </section>

        <section className="panel">
          <div className="section-title">EQUITY CURVE</div>
          <EquityCurve values={equitySeries} />
          <div className="section-title" style={{ marginTop: 12 }}>
            DAILY PROFIT
          </div>
          <DailyBars values={dailySeries} />
        </section>

        <section className="panel runner-panel">
          <div className="section-title">AI RUNNER &amp; BRAIN</div>
          <div className="runner-brain">
            <div className="runner-brain-icon">◈</div>
            <div className="badge badge-mode">{runnerOn ? 'RUNNING' : 'IDLE'}</div>
          </div>
          <div className="metric-row" style={{ marginTop: 8 }}>
            <div className="metric-box">
              <div className="label">Brain mode</div>
              <div className="value" style={{ fontSize: 12 }}>BALANCED</div>
            </div>
            <div className="metric-box">
              <div className="label">Risk level</div>
              <div className="value" style={{ fontSize: 12 }}>MEDIUM</div>
            </div>
          </div>
          <div className="actions" style={{ marginTop: 12, justifyContent: 'center' }}>
            <button className="btn btn-go" disabled={busy || runnerOn} onClick={() => void startRunner()}>
              START
            </button>
            <button className="btn btn-stop" disabled={busy || !runnerOn} onClick={() => void stopRunner()}>
              STOP
            </button>
            <button
              className="btn"
              disabled={busy}
              onClick={() => void (runnerOn ? stopRunner().then(startRunner) : startRunner())}
            >
              RESTART
            </button>
          </div>
          <div className="section-title" style={{ marginTop: 14 }}>
            LATEST AI ACTIONS
          </div>
          <div className="log-list">
            {events.length === 0 && <div>Waiting for system events…</div>}
            {events.map((e, i) => (
              <div key={e.id ?? i}>
                {(e.created_at ? new Date(e.created_at).toLocaleTimeString() : '--')} ·{' '}
                {e.event_type || e.message || 'event'}
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="dash-grid dash-mid" style={{ marginTop: 12 }}>
        <section className="panel">
          <div className="section-title">ACCOUNTS STATUS</div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Client</th>
                  <th>Env</th>
                  <th>Broker</th>
                  <th>Markets</th>
                  <th>AI Mode</th>
                </tr>
              </thead>
              <tbody>
                {accounts.length === 0 && (
                  <tr>
                    <td colSpan={6} className="mono">
                      No trading accounts — Brokers → Test, then Trading → Sync
                    </td>
                  </tr>
                )}
                {accounts.map((a) => (
                  <tr
                    key={a.account_id}
                    className={selectedAccountId === a.account_id ? 'row-active' : ''}
                    onClick={() => setSelectedAccountId(a.account_id)}
                    style={{ cursor: 'pointer' }}
                  >
                    <td>{a.display_name}</td>
                    <td>{a.client_name}</td>
                    <td>
                      <span className={`badge ${a.environment === 'live' ? 'badge-unhealthy' : 'badge-healthy'}`}>
                        {a.environment.toUpperCase()}
                      </span>
                    </td>
                    <td className="mono">{a.broker_name}</td>
                    <td className="mono">{(a.capital_market_count || 0).toLocaleString()}</td>
                    <td className="mono">Balanced</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel">
          <div className="section-title">ACTIVE TRADES (ALL ACCOUNTS)</div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th>Account</th>
                  <th>Symbol</th>
                  <th>Type</th>
                  <th>Lot</th>
                  <th>Open</th>
                  <th>P/L</th>
                </tr>
              </thead>
              <tbody>
                {positions.length === 0 && (
                  <tr>
                    <td colSpan={7} className="mono">
                      Flat — no open positions
                    </td>
                  </tr>
                )}
                {positions.map((p) => (
                  <tr key={p.id}>
                    <td className="mono">{p.id}</td>
                    <td>{p.account_name || '—'}</td>
                    <td>{p.symbol || p.instrument_id || '—'}</td>
                    <td className={(p.direction || '').toLowerCase().includes('sell') ? 'neg' : 'pos'}>
                      {(p.direction || '—').toUpperCase()}
                    </td>
                    <td className="mono">{p.quantity ?? '—'}</td>
                    <td className="mono">{p.entry_price ?? '—'}</td>
                    <td className="mono">{p.unrealized_pnl ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="sys-mini" style={{ marginTop: 12 }}>
            <div className="metric-box">
              <div className="label">CSV / Core</div>
              <div className="value" style={{ fontSize: 12 }}>{status?.market_core || '—'}</div>
            </div>
            <div className="metric-box">
              <div className="label">Execution</div>
              <div className="value" style={{ fontSize: 12 }}>{status?.execution || '—'}</div>
            </div>
            <div className="metric-box">
              <div className="label">Database</div>
              <div className="value" style={{ fontSize: 12 }}>{status?.database || '—'}</div>
            </div>
            <div className="metric-box">
              <div className="label">Feeds</div>
              <div className="value" style={{ fontSize: 12 }}>
                {status?.feeds?.active ?? 0} up / {status?.feeds?.unhealthy ?? 0} bad
              </div>
            </div>
          </div>
        </section>
      </div>

      <div className="dash-grid dash-bottom" style={{ marginTop: 12 }}>
        <section className="panel control-panel">
          <div className="section-title">ACCOUNT DETAIL</div>
          {selectedAccount ? (
            <>
              <div className="metric-box" style={{ marginBottom: 8 }}>
                <div className="label">Selected</div>
                <div className="value" style={{ fontSize: 13 }}>{selectedAccount.display_name}</div>
              </div>
              <div className="metric-row">
                <div className="metric-box">
                  <div className="label">Env</div>
                  <div className="value" style={{ fontSize: 12 }}>{selectedAccount.environment}</div>
                </div>
                <div className="metric-box">
                  <div className="label">Markets</div>
                  <div className="value" style={{ fontSize: 12 }}>
                    {(selectedAccount.capital_market_count || 0).toLocaleString()}
                  </div>
                </div>
              </div>
              <div className="section-title" style={{ marginTop: 10 }}>Open on desk</div>
              <div className="log-list">
                {accountPositions.length === 0 && <div>No open trades for this account</div>}
                {accountPositions.slice(0, 6).map((p) => (
                  <div key={p.id}>
                    #{p.id} {p.symbol || p.instrument_id} {p.direction} {p.quantity}
                  </div>
                ))}
              </div>
              <div className="actions" style={{ marginTop: 10 }}>
                <Link className="btn" to="/trading">Open Trading</Link>
              </div>
            </>
          ) : (
            <div className="empty-state">Select an account in the rail or table</div>
          )}
        </section>

        <section className="panel control-panel">
          <div className="section-title">SETTINGS &amp; PARAMETERS</div>
          <label className="field-label">Lot size mode</label>
          <select className="input" value={lotMode} onChange={(e) => setLotMode(e.target.value as 'auto' | 'fixed')}>
            <option value="auto">Auto</option>
            <option value="fixed">Fixed</option>
          </select>
          <div className="metric-row" style={{ marginTop: 8 }}>
            <div>
              <label className="field-label">Base lot</label>
              <input className="input" value={baseLot} onChange={(e) => setBaseLot(e.target.value)} />
            </div>
            <div>
              <label className="field-label">Max lot</label>
              <input className="input" value={maxLot} onChange={(e) => setMaxLot(e.target.value)} />
            </div>
          </div>
          <label className="field-label">Allowed symbols / epics</label>
          <input
            className="input"
            placeholder="e.g. EURUSD, XAUUSD, Capital epics…"
            value={allowedSymbols}
            onChange={(e) => setAllowedSymbols(e.target.value)}
          />
          <div className="actions" style={{ marginTop: 10 }}>
            <Link className="btn btn-primary" to="/trading">
              Apply in Trading
            </Link>
          </div>
        </section>

        <section className="panel control-panel">
          <div className="section-title">ORBIT READER</div>
          <p className="hint-line" style={{ marginTop: 0 }}>
            Multi-sender real quotes — no fake BUILDING status, no daily trade limits.
          </p>
          <div className="actions" style={{ marginTop: 10 }}>
            <Link className="btn btn-primary" to="/orbit">
              Open Orbit
            </Link>
            <Link className="btn" to="/feeds">
              Senders
            </Link>
          </div>
        </section>

        <section className="panel control-panel">
          <div className="section-title">AI RUNNER CONTROL</div>
          <div className="gauge-wrap">
            <div className={`gauge ${runnerOn ? 'on' : ''}`}>
              <strong>{runnerOn ? '72%' : '0%'}</strong>
              <span>PROFIT</span>
            </div>
          </div>
          <div className="actions" style={{ justifyContent: 'center', marginTop: 8 }}>
            <button className="btn btn-go" disabled={busy} onClick={() => void startRunner()}>START</button>
            <button className="btn btn-stop" disabled={busy} onClick={() => void stopRunner()}>STOP</button>
          </div>
          <div className="metric-box" style={{ marginTop: 10 }}>
            <div className="label">Desk focus</div>
            <div className="value" style={{ fontSize: 12 }}>
              {deskAccounts[0]?.client_name || '—'} / {selectedAccount?.environment || '—'}
            </div>
          </div>
        </section>

        <section className="panel control-panel">
          <div className="section-title">AI INFO LOG</div>
          <div className="log-list tall">
            <div>Conf 72% · desk sync {(status?.server_time && new Date(status.server_time).toLocaleTimeString()) || '—'}</div>
            <div>Mode {(status?.mode || 'LIVE').toUpperCase()} · live {status?.live_enabled === false ? 'OFF' : 'ON'}</div>
            <div>Capital live brokers: {status?.brokers_live ?? 0}</div>
            <div>Markets cached: {(status?.capital_markets ?? totalMarkets).toLocaleString()}</div>
            {events.slice(0, 6).map((e, i) => (
              <div key={`log-${e.id ?? i}`}>
                {e.event_type || 'sys'} · {e.message || 'ok'}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
