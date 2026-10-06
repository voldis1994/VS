import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { apiFetch } from '../hooks/useApi';
import {
  ALL_DESK_REGIMES,
  DeskCalibration,
  type AutoCalStatus,
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
  market_story?: string;
  story_chapter?: string;
  story_allow?: string;
  story_detail?: string;
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

type HtfCompact = {
  bias?: string | null;
  phase?: string | null;
  path_status?: string | null;
  primary_side?: string | null;
  structure?: string | null;
  expected_path?: string | null;
};

type RobotSession = {
  id: string;
  account_id: number;
  account_name: string;
  client_id?: number;
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
  htf_state?: HtfCompact | null;
  htf_path_status?: string | null;
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
  cycle_busy?: boolean;
  cycle_busy_age_ms?: number;
  last_tick_at?: string | null;
  last_quote_at?: string | null;
  last_activity_at?: string | null;
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

function postureMain(s: RobotSession): string {
  if (!s.running && !s.open_side) return 'STOPPED';
  if (s.open_side) return `IN TRADE · ${s.open_side}`;
  const w = s.entry_watch;
  if (w?.armed) return `ARMED · ${w.direction || '—'}`;
  if (w?.status === 'WAITING_TRIGGER') return 'WAITING';
  if (w?.status === 'FORMING') return 'WAITING';
  if (w?.status === 'REGIME_OFF') return 'REGIME OFF';
  if (w?.status === 'COOLDOWN') return 'COOLDOWN';
  if (w?.status) return w.status.replace(/_/g, ' ');
  return 'WAITING';
}

function postureSub(s: RobotSession): string {
  const r = (s.entry_watch?.regime || s.regime || 'UNKNOWN').replace(/_/g, ' ');
  return r.toUpperCase();
}

/** Pull stack dirs from looking_for / market_story when present. */
function extractStack(w: EntryWatch | null | undefined): string {
  const raw = `${w?.looking_for || ''} ${w?.market_story || ''} ${w?.story_detail || ''}`;
  const m = raw.match(/30m[↑↓→]\s*15m[↑↓→]\s*5m[↑↓→]\s*1m[↑↓→]/);
  if (m) return m[0];
  return w?.story_chapter || w?.market_story?.split(' · ')[0] || '—';
}

function extractHtfLine(s: RobotSession): string {
  const h = s.htf_state;
  if (h?.bias || h?.phase) {
    const bias = h.bias || '—';
    const phase = h.phase || '—';
    const side = h.primary_side || '—';
    return `bias ${bias} · phase ${phase} · ${side}`;
  }
  const story = s.entry_watch?.market_story || s.entry_watch?.story_detail || '';
  const m = story.match(/4H[↑↓→].*?1H[↑↓→][^·]*/);
  if (m) return m[0].trim();
  return story ? story.slice(0, 72) : '—';
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
  const [auto, setAuto] = useState<AutoCalStatus | null>(null);
  const [calBusy, setCalBusy] = useState(false);
  const [calMsg, setCalMsg] = useState<string | null>(null);
  const [lotEdit, setLotEdit] = useState('');
  const [settingsTab, setSettingsTab] = useState<'exit' | 'regimes' | 'lot'>('exit');
  const [showSetup, setShowSetup] = useState(false);
  const [showLog, setShowLog] = useState(false);

  const accountId = params.get('account_id');
  const epic = params.get('epic');
  const lot = params.get('lot');
  const name = params.get('name');

  const load = useCallback(async (robotId: string) => {
    const q = new URLSearchParams();
    if (accountId) q.set('account_id', accountId);
    if (epic) q.set('epic', epic);
    const qs = q.toString() ? `?${q}` : '';
    try {
      const s = await apiFetch<RobotSession>(
        `/api/robot-desk/${encodeURIComponent(robotId)}${qs}`
      );
      setSession(s);
      setLotEdit((prev) => (prev === '' ? String(s.lot_size) : prev));
      setError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Load failed';
      // API restart (BRAIN reload / crash) wipes in-memory session — drop ghost ARMED UI
      if (/session not found/i.test(msg)) {
        setSession(null);
        setError('Robot session pazudusi (API restart) — spied START');
        return;
      }
      throw e;
    }
  }, [accountId, epic]);

  const unitClientId = session?.client_id ?? null;
  const unitCalQs = unitClientId ? `?client_id=${unitClientId}` : '';

  useEffect(() => {
    const loadCal = () => {
      void apiFetch<{ calibration: DeskCalibration; auto?: AutoCalStatus }>(
        `/api/desk/calibration${unitCalQs}`
      )
        .then((res) => {
          setCal(res.calibration);
          if (res.auto) setAuto(res.auto);
        })
        .catch(() => setCal(null));
    };
    loadCal();
    const id = setInterval(loadCal, 3000);
    return () => clearInterval(id);
  }, [unitCalQs]);

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
    let inFlight = false;
    const t = setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      void load(routeId)
        .catch((e) =>
          setError(e instanceof Error ? e.message : 'Poll failed — dati neatjaunojas')
        )
        .finally(() => {
          inFlight = false;
        });
    }, 2000);
    return () => clearInterval(t);
  }, [routeId, load]);

  const saveCalibration = async (patch: Partial<DeskCalibration>) => {
    if (!cal) return;
    setCalBusy(true);
    setCalMsg(null);
    try {
      const res = await apiFetch<{ calibration: DeskCalibration }>(
        `/api/desk/calibration${unitCalQs}`,
        {
          method: 'PUT',
          body: JSON.stringify({ ...cal, ...patch, client_id: unitClientId }),
        }
      );
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
  const mindMatch = (w?.looking_for || w?.last_reason || '').match(/PRĀTS\s+(BUY|SELL|WAIT)/i);
  const mindSide = mindMatch?.[1]?.toUpperCase() || null;
  const setupSide = w?.direction || null;
  const setupDetail = w?.armed
    ? `${w.setup || 'SETUP'}`.trim()
    : w?.setup || (w?.status ? w.status.replace(/_/g, ' ') : '—');
  const knobs = cal || auto?.knobs_now;
  const softN = knobs ? Number(knobs.hardinv_abs).toFixed(2) : '—';
  const peakN = knobs ? Number(knobs.peak_mfe_abs).toFixed(2) : '—';
  const targetN = knobs ? Number(knobs.target_abs).toFixed(2) : '—';
  const pathStatus =
    session?.htf_path_status ||
    session?.htf_state?.path_status ||
    (session?.open_side ? '—' : 'PENDING');
  const autoCalLine =
    auto != null
      ? `${auto.closes_in_session}/${Math.max(auto.closes_in_session + auto.closes_until_next, 5)} · E pts ${Number(auto.session_expectancy_pts ?? 0).toFixed(2)}`
      : '—';
  const clock = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const liveOk = Boolean(session?.running);
  const postureKind = session?.open_side ? 'open' : session?.running ? 'watch' : 'flat';
  const tapeLine = w
    ? `CLOSED 10s O ${fmt(w.bar.o, 2)} / H ${fmt(w.bar.h, 2)} / L ${fmt(w.bar.l, 2)} / C ${fmt(w.bar.c, 2)} · ${
        w.bar.market
      }${w.bar.closed ? ' · JUST CLOSED' : ' · waiting close'}`
    : session
      ? 'Tape seeding…'
      : '—';

  const healthBanner = (() => {
    if (!session?.running) return null;
    const busyAge = session.cycle_busy ? session.cycle_busy_age_ms || 0 : 0;
    if (session.cycle_busy && busyAge >= 40_000) {
      return (
        <div className="error-state">
          CYCLE STUCK {Math.round(busyAge / 1000)}s — Capital/feed hang
        </div>
      );
    }
    if (session.cycle_busy && busyAge >= 15_000) {
      return (
        <div className="warn-state">
          Capital aizņemts {Math.round(busyAge / 1000)}s — rinda (nav hang)
        </div>
      );
    }
    if (session.cycle_busy) return null;
    const activityIso = session.last_activity_at || session.last_tick_at || session.last_quote_at;
    if (!activityIso) return null;
    const age = Date.now() - new Date(activityIso).getTime();
    if (age <= 45_000) return null;
    return (
      <div className="warn-state">
        LIVE stale — pēdējā aktivitāte {Math.round(age / 1000)}s atpakaļ
      </div>
    );
  })();

  const postureText = session
    ? postureMain(session).split('·')[0].trim()
    : busy
      ? 'STARTING'
      : 'LOADING';
  const htfBias = session?.htf_state?.bias || session?.htf_state?.phase || null;
  const pratsValue = mindSide || null;
  const setupValue = setupSide
    ? `${setupSide}${setupDetail && setupDetail !== '—' ? ` ${String(setupDetail).slice(0, 16)}` : ''}`
    : null;

  return (
    <div className="robot-fs-shell robot-unit-shell">
      <div className="vlc">
        <header className="vlc-head">
          <div className="vlc-brand">VS SYSTEM</div>
          <div className="vlc-live">
            <span className={liveOk ? 'on' : ''}>{liveOk ? 'LIVE' : 'OFF'}</span>
            <span className={`vlc-dot ${liveOk ? 'on' : ''}`} />
            <span className="mono">{clock} UTC</span>
          </div>
        </header>

        {error && <div className="error-state">{error}</div>}
        {healthBanner}

        <div className="vlc-body">
          <div className={`vlc-status ${postureKind}`}>{postureText}</div>
          <div className={`vlc-price ${session?.last_mid == null ? 'empty' : ''}`}>
            {session?.last_mid != null ? fmt(session.last_mid, 2) : '····'}
          </div>
          <div className="vlc-price-label">
            {session?.open_side
              ? `UPL ${fmt(session.unrealized, 2)} · MFE ${fmt(session.mfe, 2)} · MAE ${fmt(session.mae, 2)}`
              : session
                ? `MARKET VALUE · BID ${fmt(session.last_bid, 2)} / ASK ${fmt(session.last_ask, 2)}`
                : 'MARKET VALUE'}
          </div>

          <div className="vlc-rule" />

          <div className="vlc-section-label">
            <em className="g">PRĀTS</em> vs <em className="a">SETUP</em>
          </div>
          <div className="vlc-pair">
            <div className="vlc-card g">
              <div className="vlc-card-h g">PRĀTS</div>
              <div className={`vlc-card-v ${pratsValue ? '' : 'empty'}`}>
                {pratsValue || '——'}
              </div>
              <div className="vlc-card-s">
                {pratsValue && session ? postureSub(session) : 'NO DATA'}
              </div>
            </div>
            <div className="vlc-card a">
              <div className="vlc-card-h a">SETUP</div>
              <div className={`vlc-card-v ${setupValue ? '' : 'empty'}`}>
                {setupValue || '——'}
              </div>
              <div className="vlc-card-s">
                {setupValue ? String(pathStatus) : 'NO DATA'}
              </div>
            </div>
          </div>

          <div className="vlc-section-label muted">HTF / SOFT / PEAK</div>
          <div className="vlc-triple">
            <div className="vlc-col">
              <div className="vlc-card-h g">HTF</div>
              <div className={`vlc-card-v ${htfBias ? '' : 'empty'}`}>
                {htfBias || '——'}
              </div>
              <div className="vlc-card-s">
                {session ? extractHtfLine(session).slice(0, 28) : 'NO DATA'}
              </div>
            </div>
            <div className="vlc-col">
              <div className="vlc-card-h a">SOFT</div>
              <div className={`vlc-card-v ${softN !== '—' ? '' : 'empty'}`}>{softN}</div>
              <div className="vlc-card-s">Peak {peakN}</div>
            </div>
            <div className="vlc-col">
              <div className="vlc-card-h a">PEAK</div>
              <div className={`vlc-card-v ${peakN !== '—' ? '' : 'empty'}`}>{peakN}</div>
              <div className="vlc-card-s">Target {targetN}</div>
            </div>
          </div>

          <div className="vlc-meta mono">
            {extractStack(w)}
            {auto != null ? ` · AutoCal ${autoCalLine}` : ''}
            {tapeLine ? ` · ${tapeLine.slice(0, 48)}` : ''}
          </div>
        </div>

        <footer className="vlc-foot">
          <div className="vlc-actions">
            <button
              className="vlc-btn vlc-start"
              type="button"
              disabled={busy || session?.running}
              onClick={() => void start()}
            >
              START
            </button>
            <button
              className="vlc-btn vlc-stop"
              type="button"
              disabled={busy || !session?.running}
              onClick={() => void stop()}
            >
              STOP
            </button>
            <Link className="vlc-btn vlc-board" to="/robot">
              BOARD
            </Link>
          </div>
          <div className="vlc-foot-links">
            <button type="button" className="vlc-link" onClick={() => setShowSetup((v) => !v)}>
              {showSetup ? 'Hide setup' : 'Setup'}
            </button>
            <button type="button" className="vlc-link" onClick={() => setShowLog((v) => !v)}>
              {showLog ? 'Hide log' : 'Log'}
            </button>
            <span className="mono muted">
              {(session?.client_name || session?.account_name || '').toUpperCase()}
              {session ? ` · ${session.display_name}` : ''}
            </span>
          </div>
        </footer>

        {showSetup && (
          <section className="vu-drawer">
            <div className="vu-drawer-head">
              <div className="vu-happen-kicker">SETUP</div>
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
                      value={Number(cal.hardinv_abs).toFixed(2)}
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
                      value={Number(cal.peak_mfe_abs).toFixed(2)}
                      disabled={calBusy}
                      onChange={(e) => setCal({ ...cal, peak_mfe_abs: Number(e.target.value) })}
                      onBlur={() => void saveCalibration({ peak_mfe_abs: cal.peak_mfe_abs })}
                    />
                    <label className="field-label">Peak min giveback</label>
                    <input
                      className="input"
                      type="number"
                      step="0.05"
                      value={Number(cal.peak_min_giveback_abs).toFixed(2)}
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
                      value={Number(cal.target_abs).toFixed(2)}
                      disabled={calBusy}
                      onChange={(e) => setCal({ ...cal, target_abs: Number(e.target.value) })}
                      onBlur={() => void saveCalibration({ target_abs: cal.target_abs })}
                    />
                    <label className="field-label">Broker TP R:R (vs SL)</label>
                    <input
                      className="input"
                      type="number"
                      step="0.05"
                      min={1.5}
                      max={4}
                      value={Number(cal.safety_tp_rr ?? 1.5).toFixed(2)}
                      disabled={calBusy}
                      onChange={(e) => setCal({ ...cal, safety_tp_rr: Number(e.target.value) })}
                      onBlur={() =>
                        void saveCalibration({ safety_tp_rr: cal.safety_tp_rr ?? 1.5 })
                      }
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
                              : regimeName.includes('BREAKOUT') ||
                                  regimeName === 'REVERSAL_CANDIDATE'
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
                  Apply restartē unit ar jauno lot.
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
        )}

        {showLog && (
          <section className="vu-drawer vu-log">
            <div className="vu-happen-kicker">LIVE LOG</div>
            <div className="robot-unit-ticks">
              {session ? (
                <>
                  {session.ticks.slice(0, 40).map((t, i) => (
                    <div
                      key={`${t.at}-${i}`}
                      className={`robot-feed-line phase-${t.phase.toLowerCase()}`}
                    >
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
        )}
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
