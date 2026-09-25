import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useDesk } from '../components/DeskContext';
import { apiFetch } from '../hooks/useApi';
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
};

type AutoCalStatus = {
  enabled: boolean;
  closes_in_session: number;
  closes_until_next: number;
  cycles_run: number;
  last_summary: string | null;
  last_changes: string[];
  cooling_down: boolean;
  cooldown_left_s: number;
  session_sum_pts: number;
  session_expectancy_pts: number;
  session_wins: number;
  session_losses: number;
  knobs_now: {
    hardinv_abs: number;
    peak_mfe_abs: number;
    peak_retention: number;
    target_abs: number;
    safety_tp_rr?: number;
    entry_filter_level?: number;
    enabled_regimes: number;
  };
};

type LearnerStatus = {
  client_id: number;
  updates: number;
  updated_at: string;
};

const OPERATING_MODES = ['REPLAY', 'PAPER', 'DEMO', 'LIVE'] as const;

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
  const [runnerOn, setRunnerOn] = useState(false);
  const [auto, setAuto] = useState<AutoCalStatus | null>(null);
  const [learner, setLearner] = useState<LearnerStatus | null>(null);

  const qs = selectedClientId ? `?client_id=${selectedClientId}` : '';

  useEffect(() => {
    const load = async () => {
      try {
        const [pos, ev, autoRes, learnRes] = await Promise.all([
          apiFetch<Position[]>('/api/positions').catch(() => [] as Position[]),
          apiFetch<SystemEvent[]>('/api/system/events').catch(() => [] as SystemEvent[]),
          apiFetch<AutoCalStatus>(`/api/desk/auto-calibrate${qs}`).catch(() => null),
          apiFetch<LearnerStatus>(`/api/desk/learner${qs}`).catch(() => null),
        ]);
        setPositions(pos);
        setEvents(ev.slice(0, 8));
        if (autoRes) setAuto(autoRes);
        if (learnRes) setLearner(learnRes);
      } catch {
        /* keep last */
      }
    };
    void load();
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [qs]);

  useEffect(() => {
    setRunnerOn(Boolean(status?.live_enabled) && (status?.mode || '').toUpperCase() === 'LIVE');
  }, [status?.live_enabled, status?.mode]);

  const liveAccounts = useMemo(
    () => accounts.filter((a) => a.environment === 'live').length,
    [accounts]
  );
  const totalMarkets = useMemo(
    () => accounts.reduce((s, a) => s + (a.capital_market_count || 0), 0),
    [accounts]
  );
  const deskAccounts = useMemo(() => {
    if (!selectedClientId) return accounts;
    const filtered = accounts.filter((a) => a.client_id === selectedClientId);
    return filtered.length ? filtered : accounts;
  }, [accounts, selectedClientId]);

  const deskPositions = useMemo(() => {
    if (!selectedClientId) return positions;
    const names = new Set(
      deskAccounts.map((a) => (a.display_name || '').toLowerCase()).filter(Boolean)
    );
    const client = clients.find((c) => c.id === selectedClientId);
    const clientName = (client?.name || '').toLowerCase();
    const filtered = positions.filter((p) => {
      if (clientName && (p.client_name || '').toLowerCase() === clientName) return true;
      if (p.account_name && names.has(p.account_name.toLowerCase())) return true;
      return false;
    });
    return filtered.length || positions.length === 0 ? filtered : positions;
  }, [positions, selectedClientId, deskAccounts, clients]);

  const applyOperatingMode = async (mode: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await apiFetch('/api/system/mode', {
        method: 'POST',
        body: JSON.stringify({ mode }),
      });
      setRunnerOn(mode === 'LIVE');
      setMsg(`Mode → ${mode}`);
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
      setMsg('LIVE armed');
      refreshDesk();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Start failed');
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
      setMsg('Stopped → PAPER');
      refreshDesk();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Stop failed');
    } finally {
      setBusy(false);
    }
  };

  const factoryOpen = () => {
    void apiFetch<{ auto: AutoCalStatus; learner?: LearnerStatus }>(
      '/api/desk/auto-calibrate',
      {
        method: 'POST',
        body: JSON.stringify({
          factory_open: true,
          reset: true,
          client_id: selectedClientId ?? undefined,
        }),
      }
    )
      .then((r) => {
        setAuto(r.auto);
        if (r.learner) setLearner(r.learner);
        setMsg('OPEN TRADE-ALL · Soft 2.2 · Peak 3 · Target 5');
      })
      .catch((e) => setMsg(e instanceof Error ? e.message : 'Reset failed'));
  };

  const modeNow = (status?.mode || 'LIVE').toUpperCase();
  const ePts = auto?.session_expectancy_pts ?? 0;
  const sumPts = auto?.session_sum_pts ?? 0;

  return (
    <div className="main-dash command-dash">
      <header className="cmd-hero">
        <div className="cmd-hero-left">
          <Logo size={56} wordmark />
          <div>
            <div className="orbit-kicker">VS SYSTEM</div>
            <h1 className="page-title">COMMAND</h1>
          </div>
        </div>
        <div className="cmd-hero-actions">
          <div className="regime-catalog cmd-modes">
            {OPERATING_MODES.map((m) => (
              <button
                key={m}
                type="button"
                className={`regime-chip ${modeNow === m ? 'on up' : 'flat'}`}
                disabled={busy}
                onClick={() => void applyOperatingMode(m)}
              >
                {m}
              </button>
            ))}
          </div>
          <div className="actions" style={{ margin: 0 }}>
            <button
              className="btn btn-go"
              disabled={busy || runnerOn}
              onClick={() => void startRunner()}
            >
              START
            </button>
            <button
              className="btn btn-stop"
              disabled={busy || !runnerOn}
              onClick={() => void stopRunner()}
            >
              STOP
            </button>
            <Link className="btn btn-go" to="/robot">
              ROBOT BOARD
            </Link>
          </div>
        </div>
      </header>

      {msg && (
        <div className={msg.toLowerCase().includes('fail') ? 'error-state' : 'ok-state'}>
          {msg}
        </div>
      )}

      <section className="panel cmd-brain">
        <div className="cmd-brain-head">
          <div>
            <div className="section-title" style={{ margin: 0 }}>
              LEARNER · AUTO-CAL
              {selectedClientId ? ` · #${selectedClientId}` : ''}
            </div>
            <p className="hint-line" style={{ margin: '4px 0 0' }}>
              Online politika no closes · Soft = drošība · ik 5 closes Peak/Target mācība
            </p>
          </div>
          <div className="actions" style={{ margin: 0 }}>
            <button type="button" className="btn" onClick={factoryOpen}>
              SĀKT NO JAUNA
            </button>
            <Link className="btn" to="/trades">
              TRADES
            </Link>
          </div>
        </div>

        {!auto && <div className="empty-state">Loading…</div>}
        {auto && (
          <>
            <div className="metric-row cmd-metrics">
              <div className="metric-box">
                <div className="label">Status</div>
                <div className="value" style={{ fontSize: 15 }}>
                  {!auto.enabled
                    ? 'PAUSED'
                    : auto.cooling_down
                      ? `CD ${auto.cooldown_left_s}s`
                      : 'ON'}
                </div>
              </div>
              <div className="metric-box">
                <div className="label">Closes</div>
                <div className="value">
                  {auto.closes_in_session}
                  <span className="cmd-muted">/{auto.closes_until_next}</span>
                </div>
              </div>
              <div className="metric-box">
                <div className="label">Learner n</div>
                <div className="value">{learner?.updates ?? 0}</div>
              </div>
              <div className="metric-box">
                <div className="label">Session E</div>
                <div className={`value ${ePts >= 0 ? 'pos' : 'neg'}`}>
                  {ePts >= 0 ? '+' : ''}
                  {ePts.toFixed(2)}
                </div>
              </div>
              <div className="metric-box">
                <div className="label">Sum</div>
                <div className={`value ${sumPts >= 0 ? 'pos' : 'neg'}`}>
                  {sumPts >= 0 ? '+' : ''}
                  {sumPts.toFixed(2)}
                </div>
              </div>
              <div className="metric-box">
                <div className="label">W / L</div>
                <div className="value">
                  {auto.session_wins}/{auto.session_losses}
                </div>
              </div>
              <div className="metric-box">
                <div className="label">Cycles</div>
                <div className="value">{auto.cycles_run}</div>
              </div>
            </div>
            {auto.knobs_now && (
              <div className="hint-line mono cmd-knobs">
                Soft {auto.knobs_now.hardinv_abs} · Peak {auto.knobs_now.peak_mfe_abs}/
                {Math.round(auto.knobs_now.peak_retention * 100)}% · Target{' '}
                {auto.knobs_now.target_abs} · TP RR {auto.knobs_now.safety_tp_rr ?? 1.5} ·
                regimes {auto.knobs_now.enabled_regimes}
              </div>
            )}
            {(auto.last_summary || auto.last_changes?.length > 0) && (
              <div className="cmd-last">
                {auto.last_summary && (
                  <div className="hint-line">
                    <span className="cmd-label">Last</span> {auto.last_summary}
                  </div>
                )}
                {auto.last_changes?.length > 0 && (
                  <div className="hint-line" style={{ color: 'var(--accent)' }}>
                    <span className="cmd-label">Δ</span> {auto.last_changes.slice(0, 4).join(' · ')}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </section>

      <section className="panel cmd-kpi-panel">
        <div className="section-title">DESK SNAPSHOT</div>
        <div className="metric-row cmd-kpis">
          <div className="metric-box">
            <div className="label">Accounts</div>
            <div className="value">{accounts.length}</div>
          </div>
          <div className="metric-box">
            <div className="label">Clients</div>
            <div className="value">{clients.length}</div>
          </div>
          <div className="metric-box">
            <div className="label">Open</div>
            <div className="value">{status?.open_positions ?? positions.length}</div>
          </div>
          <div className="metric-box">
            <div className="label">Today fills</div>
            <div className="value pos">{status?.today_executions ?? 0}</div>
          </div>
          <div className="metric-box">
            <div className="label">Live</div>
            <div className="value">{liveAccounts}</div>
          </div>
          <div className="metric-box">
            <div className="label">Markets</div>
            <div className="value">{totalMarkets.toLocaleString()}</div>
          </div>
          <div className="metric-box">
            <div className="label">Runner</div>
            <div className="value" style={{ fontSize: 14 }}>
              {runnerOn ? 'LIVE' : 'IDLE'}
            </div>
          </div>
        </div>
      </section>

      <div className="cmd-tables">
        <section className="panel">
          <div className="section-title">
            ACCOUNTS
            {selectedClientId ? ` · client #${selectedClientId}` : ''} · {deskAccounts.length}
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Client</th>
                  <th>Env</th>
                  <th>Broker</th>
                  <th>Markets</th>
                </tr>
              </thead>
              <tbody>
                {deskAccounts.length === 0 && (
                  <tr>
                    <td colSpan={5} className="mono">
                      No accounts — Brokers → Test
                    </td>
                  </tr>
                )}
                {deskAccounts.map((a) => (
                  <tr
                    key={a.account_id}
                    className={selectedAccountId === a.account_id ? 'row-active' : ''}
                    onClick={() => setSelectedAccountId(a.account_id)}
                    style={{ cursor: 'pointer' }}
                  >
                    <td>{a.display_name}</td>
                    <td>{a.client_name}</td>
                    <td>
                      <span
                        className={`badge ${
                          a.environment === 'live' ? 'badge-unhealthy' : 'badge-healthy'
                        }`}
                      >
                        {a.environment.toUpperCase()}
                      </span>
                    </td>
                    <td className="mono">{a.broker_name}</td>
                    <td className="mono">{(a.capital_market_count || 0).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel">
          <div className="section-title">
            OPEN POSITIONS · {deskPositions.length}
            {(status?.open_positions ?? 0) > deskPositions.length
              ? ` (status ${status?.open_positions})`
              : ''}
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th>Account</th>
                  <th>Symbol</th>
                  <th>Side</th>
                  <th>Lot</th>
                  <th>Entry</th>
                  <th>P/L</th>
                </tr>
              </thead>
              <tbody>
                {deskPositions.length === 0 && (
                  <tr>
                    <td colSpan={7} className="mono">
                      {(status?.open_positions ?? 0) > 0
                        ? `Status rāda ${status?.open_positions} open — DB sync gaida`
                        : 'Flat — nav atvērtu pozīciju'}
                    </td>
                  </tr>
                )}
                {deskPositions.map((p) => (
                  <tr key={p.id}>
                    <td className="mono">{p.id}</td>
                    <td>{p.account_name || '—'}</td>
                    <td>{p.symbol || p.instrument_id || '—'}</td>
                    <td
                      className={
                        (p.direction || '').toLowerCase().includes('sell') ? 'neg' : 'pos'
                      }
                    >
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
        </section>
      </div>

      <section className="panel cmd-events">
        <div className="section-title">RECENT EVENTS</div>
        <div className="log-list">
          {events.length === 0 && <div className="mono">Waiting…</div>}
          {events.map((e, i) => (
            <div key={e.id ?? i}>
              {(e.created_at ? new Date(e.created_at).toLocaleTimeString() : '--')} ·{' '}
              {e.event_type || e.message || 'event'}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
