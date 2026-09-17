import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { EquityCurve, DailyBars } from '../components/Charts';
import { useDesk } from '../components/DeskContext';
import { apiFetch } from '../hooks/useApi';
import { openRobotWindow } from './RobotDeskPage';
import { Logo } from '../components/Logo';

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

type MarketOpt = {
  instrument_id: number;
  epic?: string;
  symbol: string;
  display_name: string;
  min_lot: number;
  lot_size: number;
};

const OPERATING_MODES = ['REPLAY', 'PAPER', 'DEMO', 'LIVE'] as const;

const ALL_REGIMES = [
  'RANGE',
  'TREND_UP',
  'TREND_DOWN',
  'PULLBACK_UPTREND',
  'PULLBACK_DOWNTREND',
  'COMPRESSION',
  'EXPANSION',
  'BREAKOUT_UP',
  'BREAKOUT_DOWN',
  'FAILED_BREAKOUT_UP',
  'FAILED_BREAKOUT_DOWN',
  'REVERSAL_CANDIDATE',
  'TRANSITION',
] as const;

type DeskCalibration = {
  hardinv_abs: number;
  peak_mfe_abs: number;
  peak_retention: number;
  peak_min_giveback_abs: number;
  target_abs: number;
  hardinv_pct: number;
  target_pct: number;
  peak_mfe_pct: number;
  enabled_regimes: string[];
  updated_at?: string;
};


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
  const [markets, setMarkets] = useState<MarketOpt[]>([]);
  const [marketEpic, setMarketEpic] = useState('');
  const [lotSize, setLotSize] = useState('0.1');
  const [marketFilter, setMarketFilter] = useState('');
  const [runnerOn, setRunnerOn] = useState(false);
  const [showExtraPanels, setShowExtraPanels] = useState(false);
  const [cal, setCal] = useState<DeskCalibration | null>(null);
  const [calBusy, setCalBusy] = useState(false);
  const [calMsg, setCalMsg] = useState<string | null>(null);

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

  useEffect(() => {
    void apiFetch<{ calibration: DeskCalibration }>('/api/desk/calibration')
      .then((res) => setCal(res.calibration))
      .catch(() => setCal(null));
  }, []);

  const saveCalibration = async (patch: Partial<DeskCalibration>) => {
    if (!cal) return;
    setCalBusy(true);
    setCalMsg(null);
    try {
      const res = await apiFetch<{ calibration: DeskCalibration }>('/api/desk/calibration', {
        method: 'PUT',
        body: JSON.stringify({ ...cal, ...patch }),
      });
      setCal(res.calibration);
      setCalMsg('Saved');
    } catch (e) {
      setCalMsg(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setCalBusy(false);
    }
  };

  const toggleRegime = (name: string) => {
    if (!cal) return;
    const on = cal.enabled_regimes.includes(name);
    const next = on
      ? cal.enabled_regimes.filter((r) => r !== name)
      : [...cal.enabled_regimes, name];
    void saveCalibration({ enabled_regimes: next });
  };


  useEffect(() => {
    if (!selectedAccountId) {
      setMarkets([]);
      setMarketEpic('');
      return;
    }
    void apiFetch<MarketOpt[]>(`/api/trading/accounts/${selectedAccountId}/instruments`)
      .then((rows) => {
        // Broker epic 1:1 only — no invented names / symbol fallback
        const brokerRows = (rows || []).filter((r) => String(r.epic || '').trim().length > 0);
        setMarkets(brokerRows);
        setMarketEpic((prev) =>
          prev && brokerRows.some((r) => r.epic === prev) ? prev : ''
        );
      })
      .catch(() => {
        setMarkets([]);
        setMarketEpic('');
      });
  }, [selectedAccountId]);

  const filteredMarkets = useMemo(() => {
    const q = marketFilter.trim().toLowerCase();
    const onlyEpic = markets.filter((m) => String(m.epic || '').trim().length > 0);
    if (!q) return onlyEpic.slice(0, 200);
    return onlyEpic
      .filter(
        (m) =>
          String(m.display_name || '').toLowerCase().includes(q) ||
          String(m.epic).toLowerCase().includes(q)
      )
      .slice(0, 200);
  }, [markets, marketFilter]);

  const selectedMarket = markets.find((m) => m.epic === marketEpic) || null;

  const startRobotTrading = () => {
    if (!selectedAccountId || !selectedMarket?.epic) {
      setMsg('Izvēlies account + Capital epic 1:1 (Pull markets Trading lapā, ja tukšs)');
      return;
    }
    const lot = Number(lotSize);
    if (!Number.isFinite(lot) || lot <= 0) {
      setMsg('Lot size must be > 0');
      return;
    }
    const name = selectedMarket.display_name || selectedMarket.epic;
    // Named window per account+epic — same client/instrument reuses window; others stay independent
    const w = openRobotWindow({
      accountId: selectedAccountId,
      epic: selectedMarket.epic,
      lot,
      name,
    });
    if (!w) {
      setMsg(`Robot board · ${name} · epic ${selectedMarket.epic} · lot ${lot}`);
    } else {
      setMsg(`Robot board · ${name} · epic ${selectedMarket.epic} · lot ${lot}`);
    }
  };

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

  const applyOperatingMode = async (mode: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await apiFetch('/api/system/mode', {
        method: 'POST',
        body: JSON.stringify({ mode }),
      });
      setRunnerOn(mode === 'LIVE');
      setMsg(`Operating mode → ${mode}`);
      refreshDesk();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Mode change failed');
    } finally {
      setBusy(false);
    }
  };

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
        <div className="dash-brand-hero">
          <Logo size={96} wordmark />
          <div>
            <div className="orbit-kicker">VS SYSTEM // COMMAND</div>
            <h1 className="page-title">MAIN DASHBOARD</h1>
            <p className="page-subtitle">
              Tactical desk · accounts · risk · Capital.com live combat feed
            </p>
          </div>
        </div>
        {msg && <div className={msg.includes('Failed') ? 'error-state' : 'ok-state'}>{msg}</div>}
      </div>

      <div className="control-fit-bar">
        <div className="section-title" style={{ margin: 0 }}>CONTROL</div>
        <button
          type="button"
          className="btn"
          onClick={() => setShowExtraPanels((v) => !v)}
        >
          {showExtraPanels ? 'Hide info' : 'Info / more'}
        </button>
      </div>
      <div className="dash-grid dash-bottom control-fit-scroll control-fit-primary">
        <section className="panel control-panel">
          <div className="section-title">START ROBOT</div>
          <p className="hint-line" style={{ marginTop: 0, marginBottom: 8 }}>
            Izvēlies Capital.com tirgu + lot → TRADING ON → atveras Robot Desk (redzams live log).
          </p>
          {!selectedAccountId && (
            <div className="error-state">Vispirms izvēlies account kreisajā rail / Accounts Status.</div>
          )}
          {selectedAccountId && markets.length === 0 && (
            <div className="error-state" style={{ marginBottom: 8 }}>
              Nav tirgu. <Link to="/trading">Trading</Link> → Pull ALL Capital.com markets.
            </div>
          )}
          <label className="field-label">Search market</label>
          <input
            className="input"
            placeholder="Capital.com name…"
            value={marketFilter}
            onChange={(e) => setMarketFilter(e.target.value)}
            disabled={!markets.length}
          />
          <label className="field-label">Broker market (epic 1:1)</label>
          <select
            className="input"
            value={marketEpic}
            onChange={(e) => {
              const epic = e.target.value;
              setMarketEpic(epic);
              const m = markets.find((x) => x.epic === epic);
              if (m) setLotSize(String(m.lot_size || m.min_lot || 0.1));
            }}
            disabled={!markets.length}
          >
            <option value="">— select Capital epic —</option>
            {filteredMarkets.map((m) => (
              <option key={m.instrument_id} value={m.epic}>
                {m.display_name} · {m.epic}
              </option>
            ))}
          </select>
          {selectedMarket && (
            <div className="hint-line" style={{ marginTop: 4 }}>
              Order epic: <span className="mono">{selectedMarket.epic}</span> (broker exact)
            </div>
          )}
          <label className="field-label">Lot size</label>
          <input
            className="input"
            value={lotSize}
            onChange={(e) => setLotSize(e.target.value)}
            disabled={!markets.length}
          />
          <div className="actions" style={{ marginTop: 10 }}>
            <button
              className="btn btn-go"
              disabled={busy || !marketEpic || !selectedAccountId}
              onClick={startRobotTrading}
            >
              TRADING ON → ROBOT
            </button>
          </div>
          {msg && <div className="hint-line" style={{ marginTop: 8 }}>{msg}</div>}
        </section>

        <section className="panel control-panel">
          <div className="section-title">EXIT CALIBRATION</div>
          <p className="hint-line" style={{ marginTop: 0, marginBottom: 8 }}>
            HardInv / Peak % / Target — live Soft exits (broker SAFETY SL remains cushion).
          </p>
          {!cal && <div className="empty-state">Loading knobs…</div>}
          {cal && (
            <>
              <label className="field-label">HardInv abs (pts)</label>
              <input
                className="input"
                type="number"
                step="0.1"
                value={cal.hardinv_abs}
                disabled={calBusy}
                onChange={(e) => setCal({ ...cal, hardinv_abs: Number(e.target.value) })}
                onBlur={() => void saveCalibration({ hardinv_abs: cal.hardinv_abs })}
              />
              <label className="field-label">Peak keep % (75 = 25% giveback)</label>
              <input
                className="input"
                type="number"
                step="1"
                min={50}
                max={95}
                value={Math.round(cal.peak_retention * 100)}
                disabled={calBusy}
                onChange={(e) =>
                  setCal({ ...cal, peak_retention: Number(e.target.value) / 100 })
                }
                onBlur={() => void saveCalibration({ peak_retention: cal.peak_retention })}
              />
              <label className="field-label">Peak MFE floor (pts)</label>
              <input
                className="input"
                type="number"
                step="0.1"
                value={cal.peak_mfe_abs}
                disabled={calBusy}
                onChange={(e) => setCal({ ...cal, peak_mfe_abs: Number(e.target.value) })}
                onBlur={() => void saveCalibration({ peak_mfe_abs: cal.peak_mfe_abs })}
              />
              <label className="field-label">Peak min giveback (pts)</label>
              <input
                className="input"
                type="number"
                step="0.05"
                value={cal.peak_min_giveback_abs}
                disabled={calBusy}
                onChange={(e) =>
                  setCal({ ...cal, peak_min_giveback_abs: Number(e.target.value) })
                }
                onBlur={() =>
                  void saveCalibration({ peak_min_giveback_abs: cal.peak_min_giveback_abs })
                }
              />
              <label className="field-label">Target abs (pts)</label>
              <input
                className="input"
                type="number"
                step="0.1"
                value={cal.target_abs}
                disabled={calBusy}
                onChange={(e) => setCal({ ...cal, target_abs: Number(e.target.value) })}
                onBlur={() => void saveCalibration({ target_abs: cal.target_abs })}
              />
              <div className="actions" style={{ marginTop: 8 }}>
                <button
                  className="btn btn-primary"
                  disabled={calBusy}
                  onClick={() => void saveCalibration({})}
                >
                  Save knobs
                </button>
              </div>
              {calMsg && <div className="hint-line" style={{ marginTop: 6 }}>{calMsg}</div>}
            </>
          )}
        </section>

        <section className="panel control-panel">
          <div className="section-title">TRADE REGIMES</div>
          <p className="hint-line" style={{ marginTop: 0, marginBottom: 8 }}>
            Izvēlies vienu vai vairākus — entry tikai ieslēgtajos režīmos.
          </p>
          <div className="regime-catalog">
            {ALL_REGIMES.map((name) => {
              const on = Boolean(cal?.enabled_regimes.includes(name));
              return (
                <button
                  key={name}
                  type="button"
                  className={`regime-chip ${on ? 'on' : ''} ${
                    name.includes('UP') || name === 'EXPANSION'
                      ? 'up'
                      : name.includes('DOWN') || name === 'COMPRESSION'
                        ? 'down'
                        : name.includes('BREAKOUT') || name === 'REVERSAL_CANDIDATE'
                          ? 'scalp'
                          : 'flat'
                  }`}
                  disabled={calBusy || !cal}
                  onClick={() => toggleRegime(name)}
                >
                  {name}
                </button>
              );
            })}
          </div>
          <div className="actions" style={{ marginTop: 8 }}>
            <button
              className="btn"
              disabled={calBusy || !cal}
              onClick={() => void saveCalibration({ enabled_regimes: [...ALL_REGIMES] })}
            >
              All on
            </button>
            <button
              className="btn"
              disabled={calBusy || !cal}
              onClick={() => void saveCalibration({ enabled_regimes: [] })}
            >
              All off
            </button>
          </div>
        </section>

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
      </div>

      <div className="dash-grid dash-top" style={{ marginTop: 12 }}>
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
              <div className="label">Operating mode</div>
              <div className="value" style={{ fontSize: 12 }}>
                {(status?.mode || 'LIVE').toUpperCase()}
              </div>
            </div>
            <div className="metric-box">
              <div className="label">Risk level</div>
              <div className="value" style={{ fontSize: 12 }}>MEDIUM</div>
            </div>
          </div>
          <div className="regime-catalog" style={{ marginTop: 10 }}>
            {OPERATING_MODES.map((m) => (
              <button
                key={m}
                type="button"
                className={`regime-chip ${
                  (status?.mode || 'LIVE').toUpperCase() === m ? 'on up' : 'flat'
                }`}
                disabled={busy}
                onClick={() => void applyOperatingMode(m)}
              >
                {m}
              </button>
            ))}
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

      {showExtraPanels && (
        <div className="dash-grid dash-bottom control-fit-scroll" style={{ marginTop: 12 }}>
          <section className="panel control-panel">
            <div className="section-title">ORBIT READER</div>
            <p className="hint-line" style={{ marginTop: 0 }}>
              Multi-sender quotes (read-only).
            </p>
            <div className="actions" style={{ marginTop: 10 }}>
              <Link className="btn btn-primary" to="/orbit">
                Open Orbit
              </Link>
              <Link className="btn" to="/robot">
                Robot Desk
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
      )}
    </div>
  );
}
