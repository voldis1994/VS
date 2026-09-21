import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { apiFetch } from '../hooks/useApi';
import { Logo } from '../components/Logo';
import {
  ALL_DESK_REGIMES,
  DeskCalibration,
} from '../components/DeskControlPanel';

type RobotTick = {
  at: string;
  phase: string;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  detail: string;
};

type FeedLeg = {
  sender_id: string;
  name: string;
  ok: boolean;
  mid: number | null;
  latency_ms: number;
  detail?: string;
};

type EntryWatch = {
  regime: string;
  regime_enabled: boolean;
  status: string;
  looking_for: string;
  bar_vs_trigger: string;
  direction: 'BUY' | 'SELL' | null;
  setup: string | null;
  armed: boolean;
  zone_bars?: number;
  zone_need?: number;
  zone_full?: number;
  zone_left?: number;
  zone_ready?: boolean;
  zone_progress?: string;
  bar: {
    o: number | null;
    h: number | null;
    l: number | null;
    c: number | null;
    forming_c: number | null;
    body_pct: number | null;
    range_pct: number | null;
    market: string;
    closed: boolean;
  };
  last_reason: string;
};

type RobotSession = {
  id: string;
  account_id: number;
  account_name: string;
  client_name?: string;
  environment: string;
  epic: string;
  display_name: string;
  lot_size: number;
  running: boolean;
  ticks: RobotTick[];
  last_mid: number | null;
  last_bid?: number | null;
  last_ask?: number | null;
  last_deal_reference?: string | null;
  deal_id: string | null;
  entry_price: number | null;
  mfe: number;
  mae: number;
  unrealized: number | null;
  mode: string;
  regime?: string;
  feed_source?: string;
  feed_contributing?: number;
  feed_sender_count?: number;
  feed_agreement?: string | null;
  feed_legs?: FeedLeg[];
  decision_chain?: { feeds: string; ohlc: string; regime: string; setup: string | null; action: string };
  entry_watch?: EntryWatch | null;
  ohlc_10s?: {
    last_o: number | null;
    last_h: number | null;
    last_l: number | null;
    last_c: number | null;
    forming_c: number | null;
    forming_body_pct?: number | null;
    forming_range_pct?: number | null;
    body_pct: number | null;
    range_pct?: number | null;
    market: string;
  };
  orders_placed: number;
  exits_done: number;
  reads_ok: number;
  reads_fail: number;
  open_side: string | null;
  safety_sl: number | null;
  error: string | null;
};

function fmt(n: number | null | undefined, d = 5) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, { maximumFractionDigits: d });
}

function pctFmt(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const p = v * 100;
  const sign = p > 0 ? '+' : '';
  return `${sign}${p.toFixed(3)}%`;
}

function postureLabel(s: RobotSession): string {
  if (!s.running && !s.open_side) return 'STOPPED';
  if (s.open_side) return `${s.open_side} OPEN`;
  const w = s.entry_watch;
  if (w?.armed) return `ARMED ${w.direction || ''} · ${w.regime}`;
  if (w?.status) return `${w.status} · ${w.regime}`;
  return `WAIT · ${(s.regime || 'UNKNOWN').toUpperCase()}`;
}

/** Fullscreen page — one client robot only, fit viewport. */
export function RobotUnitPage() {
  const { id: routeId } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [session, setSession] = useState<RobotSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [booted, setBooted] = useState(false);
  const [cal, setCal] = useState<DeskCalibration | null>(null);
  const [calBusy, setCalBusy] = useState(false);
  const [calMsg, setCalMsg] = useState<string | null>(null);
  const [lotEdit, setLotEdit] = useState('');
  const [settingsTab, setSettingsTab] = useState<'exit' | 'regimes' | 'lot'>('exit');

  const accountId = params.get('account_id');
  const epic = params.get('epic');
  const lot = params.get('lot');
  const name = params.get('name');

  const load = useCallback(async (robotId: string) => {
    const q = new URLSearchParams();
    if (accountId) q.set('account_id', accountId);
    if (epic) q.set('epic', epic);
    const qs = q.toString() ? `?${q}` : '';
    const s = await apiFetch<RobotSession>(`/api/robot-desk/${encodeURIComponent(robotId)}${qs}`);
    setSession(s);
    setLotEdit((prev) => (prev === '' ? String(s.lot_size) : prev));
    setError(null);
  }, [accountId, epic]);

  useEffect(() => {
    void apiFetch<{ calibration: DeskCalibration }>('/api/desk/calibration')
      .then((res) => setCal(res.calibration))
      .catch(() => setCal(null));
  }, []);

  // Boot: start from query if needed, then lock onto unit id
  useEffect(() => {
    if (booted) return;
    if (accountId && epic && lot && !routeId) {
      setBooted(true);
      setBusy(true);
      void apiFetch<{ session: RobotSession }>('/api/robot-desk/start', {
        method: 'POST',
        body: JSON.stringify({
          account_id: Number(accountId),
          epic,
          display_name: name || undefined,
          lot_size: Number(lot),
          trading_enabled: true,
        }),
      })
        .then((res) => {
          navigate(`/robot/unit/${encodeURIComponent(res.session.id)}`, { replace: true });
          setSession(res.session);
          setLotEdit(String(res.session.lot_size));
        })
        .catch((e) => setError(e instanceof Error ? e.message : 'Start failed'))
        .finally(() => setBusy(false));
      return;
    }
    if (routeId) {
      setBooted(true);
      void load(routeId).catch((e) =>
        setError(e instanceof Error ? e.message : 'Load failed'),
      );
    }
  }, [booted, accountId, epic, lot, name, routeId, navigate, load]);

  useEffect(() => {
    if (!routeId) return;
    const t = setInterval(() => {
      void load(routeId).catch(() => undefined);
    }, 2000);
    return () => clearInterval(t);
  }, [routeId, load]);

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

  const toggleRegime = (regimeName: string) => {
    if (!cal) return;
    const on = cal.enabled_regimes.includes(regimeName);
    const next = on
      ? cal.enabled_regimes.filter((r) => r !== regimeName)
      : [...cal.enabled_regimes, regimeName];
    void saveCalibration({ enabled_regimes: next });
  };

  const start = async (lotOverride?: number) => {
    if (!session) return;
    const nextLot = lotOverride ?? session.lot_size;
    if (!Number.isFinite(nextLot) || nextLot <= 0) {
      setError('Lot size must be > 0');
      return;
    }
    setBusy(true);
    try {
      const res = await apiFetch<{ session: RobotSession }>('/api/robot-desk/start', {
        method: 'POST',
        body: JSON.stringify({
          account_id: session.account_id,
          epic: session.epic,
          display_name: session.display_name,
          lot_size: nextLot,
          trading_enabled: true,
        }),
      });
      setSession(res.session);
      setLotEdit(String(res.session.lot_size));
      if (res.session.id !== routeId) {
        navigate(`/robot/unit/${encodeURIComponent(res.session.id)}`, { replace: true });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Start failed');
    } finally {
      setBusy(false);
    }
  };

  const applyLot = async () => {
    const next = Number(lotEdit);
    if (!Number.isFinite(next) || next <= 0) {
      setError('Lot size must be > 0');
      return;
    }
    setCalMsg(null);
    await start(next);
    setCalMsg(`Lot → ${next}`);
  };

  const stop = async () => {
    if (!session) return;
    setBusy(true);
    try {
      await apiFetch(`/api/robot-desk/${encodeURIComponent(session.id)}/stop`, {
        method: 'POST',
      });
      await load(session.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Stop failed');
    } finally {
      setBusy(false);
    }
  };

  const w = session?.entry_watch;
  const chain = session?.decision_chain;

  return (
    <div className="robot-fs-shell robot-unit-shell">
      <div className="robot-unit">
        <header className="robot-unit-head">
          <div className="robot-unit-brand">
            <Logo size={48} wordmark />
            <div>
              <div className="robot-arena-kicker">VS SYSTEM // CLIENT ROBOT</div>
              <h1 className="robot-unit-title">
                {(session?.client_name || session?.account_name || '…').toUpperCase()}
                {session ? ` · ${session.display_name}` : ''}
              </h1>
              <p className="robot-unit-sub mono">
                {session
                  ? `${session.epic} · lot ${session.lot_size} · ${session.environment.toUpperCase()} · ${session.id}`
                  : busy
                    ? 'Starting…'
                    : 'Loading…'}
              </p>
            </div>
          </div>
          <div className="robot-unit-actions">
            <button className="btn btn-go" type="button" disabled={busy || session?.running} onClick={() => void start()}>
              START
            </button>
            <button className="btn btn-stop" type="button" disabled={busy || !session?.running} onClick={() => void stop()}>
              STOP
            </button>
            <Link className="btn" to="/robot">
              BOARD
            </Link>
          </div>
        </header>

        {error && <div className="error-state">{error}</div>}

        <div className="robot-unit-grid">
          <section className="robot-unit-panel robot-unit-status">
            <div className="robot-arena-kicker">STATUS</div>
            {session ? (
              <>
                <div className={`robot-unit-posture ${session.open_side ? 'open' : session.running ? 'watch' : 'flat'}`}>
                  {postureLabel(session)}
                </div>
                <div className="robot-unit-metrics">
                  <div>
                    <span>SELL / BID</span>
                    <strong>{fmt(session.last_bid)}</strong>
                  </div>
                  <div>
                    <span>BUY / ASK</span>
                    <strong>{fmt(session.last_ask)}</strong>
                  </div>
                  <div>
                    <span>MID</span>
                    <strong>{fmt(session.last_mid)}</strong>
                  </div>
                  <div>
                    <span>UPL</span>
                    <strong className={(session.unrealized || 0) >= 0 ? 'pos' : 'neg'}>
                      {fmt(session.unrealized)}
                    </strong>
                  </div>
                  <div>
                    <span>MFE / MAE</span>
                    <strong>
                      {fmt(session.mfe)} / {fmt(session.mae)}
                    </strong>
                  </div>
                  <div>
                    <span>MODE</span>
                    <strong>{session.running ? session.mode : 'STOPPED'}</strong>
                  </div>
                  <div>
                    <span>REGIME</span>
                    <strong>{(session.regime || 'UNKNOWN').toUpperCase()}</strong>
                  </div>
                  <div>
                    <span>SIDE / ENTRY</span>
                    <strong>
                      {session.open_side || 'FLAT'} · {fmt(session.entry_price)}
                    </strong>
                  </div>
                  <div>
                    <span>SAFETY SL</span>
                    <strong>{fmt(session.safety_sl)}</strong>
                  </div>
                  <div>
                    <span>DEAL</span>
                    <strong className="mono">{session.deal_id || '—'}</strong>
                  </div>
                  <div>
                    <span>IN / OUT</span>
                    <strong>
                      {session.orders_placed} / {session.exits_done}
                    </strong>
                  </div>
                  <div>
                    <span>READS</span>
                    <strong>
                      {session.reads_ok}/{session.reads_fail}
                    </strong>
                  </div>
                </div>
                {chain && (
                  <div className="robot-unit-chain mono">
                    {chain.feeds} → {chain.ohlc} → {chain.regime}
                    {chain.setup ? ` · ${chain.setup}` : ''} → {chain.action}
                  </div>
                )}
              </>
            ) : (
              <div className="muted">{busy ? 'Starting…' : 'Waiting for session…'}</div>
            )}
          </section>

          <section className={`robot-unit-panel robot-unit-watch ${w?.armed ? 'armed' : ''}`}>
            <div className="robot-arena-kicker">ENTRY WATCH</div>
            {w ? (
              <>
                <div className="robot-unit-watch-status">
                  <strong>{w.status}</strong>
                  {w.armed ? ` · ARMED ${w.direction || ''} ${w.setup || ''}` : ''}
                  {w.regime_enabled ? ' · REGIME ON' : ' · REGIME OFF'}
                </div>
                <div className="robot-unit-watch-look">{w.looking_for}</div>
                {w.zone_progress && (
                  <div className="mono">
                    ZONA · {w.zone_bars ?? '—'}/{w.zone_need ?? 90}
                    {w.zone_ready
                      ? ` · gatavs · mērķis ${w.zone_full ?? 180}`
                      : ` · vēl ${w.zone_left ?? '—'} sveces (≈${Math.max(
                          1,
                          Math.ceil(((w.zone_left ?? 0) * 10) / 60)
                        )}m)`}
                  </div>
                )}
                <div className="mono">
                  CLOSED 10s · O {fmt(w.bar.o, 2)} H {fmt(w.bar.h, 2)} L {fmt(w.bar.l, 2)} C{' '}
                  {fmt(w.bar.c, 2)}
                  {w.bar.forming_c != null ? ` · LIVE ${fmt(w.bar.forming_c, 2)}` : ''}
                </div>
                <div className="mono">
                  CLOSED BODY {pctFmt(w.bar.body_pct)} · RANGE {pctFmt(w.bar.range_pct)} ·{' '}
                  {w.bar.market}
                  {w.bar.closed ? ' · JUST CLOSED' : ' · waiting close'}
                </div>
                {session?.ohlc_10s?.forming_body_pct != null && (
                  <div className="mono muted">
                    LIVE forming body {pctFmt(session.ohlc_10s.forming_body_pct)} · range{' '}
                    {pctFmt(session.ohlc_10s.forming_range_pct)}
                  </div>
                )}
                <div className="robot-unit-watch-vs">{w.bar_vs_trigger}</div>
                <div className="muted">{w.last_reason}</div>
              </>
            ) : (
              <div className="muted">{session ? 'Watch seeding…' : 'Waiting for session…'}</div>
            )}
            {session && (
              <>
                <div className="robot-unit-ohlc mono" style={{ marginTop: 8 }}>
                  10s CLOSED · O {fmt(session.ohlc_10s?.last_o, 2)} H {fmt(session.ohlc_10s?.last_h, 2)} L{' '}
                  {fmt(session.ohlc_10s?.last_l, 2)} C {fmt(session.ohlc_10s?.last_c, 2)} ·{' '}
                  {session.ohlc_10s?.market || 'SEEDING'} · body {pctFmt(session.ohlc_10s?.body_pct)}
                </div>
                <div className="mono" style={{ marginTop: 4 }}>
                  FEEDS · {session.feed_contributing ?? 0}/{session.feed_sender_count ?? 0}{' '}
                  {session.feed_agreement || ''} · {session.feed_source || '—'}
                </div>
                {(session.feed_legs?.length ?? 0) > 0 && (
                  <div className="robot-unit-legs">
                    {session.feed_legs!.map((leg) => (
                      <span key={leg.sender_id} className={leg.ok ? 'ok' : 'bad'}>
                        {leg.name}:{leg.ok ? fmt(leg.mid, 2) : '×'} {leg.latency_ms}ms
                      </span>
                    ))}
                  </div>
                )}
                {session.error && <div className="error-state" style={{ marginTop: 8 }}>{session.error}</div>}
              </>
            )}
          </section>

          <section className="robot-unit-panel robot-unit-settings">
            <div className="robot-arena-kicker">SETTINGS</div>
            <div className="robot-unit-settings-tabs">
              <button
                type="button"
                className={`btn ${settingsTab === 'exit' ? 'btn-primary' : ''}`}
                onClick={() => setSettingsTab('exit')}
              >
                EXIT
              </button>
              <button
                type="button"
                className={`btn ${settingsTab === 'regimes' ? 'btn-primary' : ''}`}
                onClick={() => setSettingsTab('regimes')}
              >
                REGIMES
              </button>
              <button
                type="button"
                className={`btn ${settingsTab === 'lot' ? 'btn-primary' : ''}`}
                onClick={() => setSettingsTab('lot')}
              >
                LOT
              </button>
            </div>

            {settingsTab === 'exit' && (
              <div className="robot-unit-settings-body">
                {!cal && <div className="muted">Loading calibration…</div>}
                {cal && (
                  <div className="robot-unit-settings-fields">
                    <label className="field-label">HardInv abs</label>
                    <input
                      className="input"
                      type="number"
                      step="0.1"
                      value={cal.hardinv_abs}
                      disabled={calBusy}
                      onChange={(e) => setCal({ ...cal, hardinv_abs: Number(e.target.value) })}
                      onBlur={() => void saveCalibration({ hardinv_abs: cal.hardinv_abs })}
                    />
                    <label className="field-label">Peak keep % (75=25% giveback)</label>
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
                    <label className="field-label">Peak MFE floor</label>
                    <input
                      className="input"
                      type="number"
                      step="0.1"
                      value={cal.peak_mfe_abs}
                      disabled={calBusy}
                      onChange={(e) => setCal({ ...cal, peak_mfe_abs: Number(e.target.value) })}
                      onBlur={() => void saveCalibration({ peak_mfe_abs: cal.peak_mfe_abs })}
                    />
                    <label className="field-label">Peak min giveback</label>
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
                    <label className="field-label">Target abs</label>
                    <input
                      className="input"
                      type="number"
                      step="0.1"
                      value={cal.target_abs}
                      disabled={calBusy}
                      onChange={(e) => setCal({ ...cal, target_abs: Number(e.target.value) })}
                      onBlur={() => void saveCalibration({ target_abs: cal.target_abs })}
                    />
                    <div className="actions" style={{ marginTop: 4 }}>
                      <button
                        className="btn btn-primary"
                        type="button"
                        disabled={calBusy}
                        onClick={() => void saveCalibration({})}
                      >
                        Save knobs
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {settingsTab === 'regimes' && (
              <div className="robot-unit-settings-body">
                <p className="hint-line" style={{ margin: '0 0 6px' }}>
                  Entry tikai ieslēgtajos regimes.
                </p>
                <div className="regime-catalog desk-control-regimes robot-unit-regimes">
                  {ALL_DESK_REGIMES.map((regimeName) => {
                    const on = Boolean(cal?.enabled_regimes.includes(regimeName));
                    return (
                      <button
                        key={regimeName}
                        type="button"
                        className={`regime-chip ${on ? 'on' : ''} ${
                          regimeName.includes('UP') || regimeName === 'EXPANSION'
                            ? 'up'
                            : regimeName.includes('DOWN') || regimeName === 'COMPRESSION'
                              ? 'down'
                              : regimeName.includes('BREAKOUT') || regimeName === 'REVERSAL_CANDIDATE'
                                ? 'scalp'
                                : 'flat'
                        }`}
                        disabled={calBusy || !cal}
                        onClick={() => toggleRegime(regimeName)}
                      >
                        {regimeName}
                      </button>
                    );
                  })}
                </div>
                <div className="actions" style={{ marginTop: 6 }}>
                  <button
                    className="btn"
                    type="button"
                    disabled={calBusy || !cal}
                    onClick={() => void saveCalibration({ enabled_regimes: [...ALL_DESK_REGIMES] })}
                  >
                    All on
                  </button>
                  <button
                    className="btn"
                    type="button"
                    disabled={calBusy || !cal}
                    onClick={() => void saveCalibration({ enabled_regimes: [] })}
                  >
                    All off
                  </button>
                </div>
              </div>
            )}

            {settingsTab === 'lot' && (
              <div className="robot-unit-settings-body">
                <label className="field-label">Lot size</label>
                <input
                  className="input"
                  value={lotEdit || lot || ''}
                  onChange={(e) => setLotEdit(e.target.value)}
                  disabled={busy}
                />
                <p className="hint-line" style={{ margin: '4px 0 0' }}>
                  Apply restartē robotu ar jauno lot (šim klientam).
                </p>
                <div className="actions" style={{ marginTop: 6 }}>
                  <button
                    className="btn btn-primary"
                    type="button"
                    disabled={busy || !session}
                    onClick={() => void applyLot()}
                  >
                    Apply lot
                  </button>
                </div>
              </div>
            )}

            {calMsg && <div className="hint-line">{calMsg}</div>}
          </section>

          <section className="robot-unit-panel robot-unit-feed">
            <div className="robot-arena-kicker">LIVE LOG</div>
            <div className="robot-unit-ticks">
              {session ? (
                <>
                  {session.ticks.slice(0, 50).map((t, i) => (
                    <div key={`${t.at}-${i}`} className={`robot-feed-line phase-${t.phase.toLowerCase()}`}>
                      <span className="mono time">{new Date(t.at).toLocaleTimeString()}</span>
                      <span className="badge phase">{t.phase}</span>
                      <span className="detail">{t.detail}</span>
                    </div>
                  ))}
                  {session.ticks.length === 0 && <div className="mono">Waiting for feed…</div>}
                </>
              ) : (
                <div className="mono">Waiting for session…</div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

/** Start robot and open dedicated fullscreen unit page (new tab/window). */
export function openRobotUnitPage(opts: {
  accountId: number;
  epic: string;
  lot: number;
  name: string;
}) {
  const q = new URLSearchParams({
    account_id: String(opts.accountId),
    epic: opts.epic,
    lot: String(opts.lot),
    name: opts.name,
  });
  const url = `/robot/unit?${q.toString()}`;
  const w = window.open(url, `robot_${opts.accountId}_${opts.epic}`, 'noopener,noreferrer');
  if (!w) {
    window.location.href = url;
  }
  return w;
}
