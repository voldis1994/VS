import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { apiFetch } from '../hooks/useApi';
import { Logo } from '../components/Logo';

type RobotTick = {
  at: string;
  phase: string;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  detail: string;
};

const ALL_REGIMES = ['TREND_UP', 'TREND_DOWN', 'RANGE'] as const;

type FeedLeg = {
  sender_id: string;
  name: string;
  ok: boolean;
  mid: number | null;
  latency_ms: number;
  detail?: string;
  role?: 'LEAD' | 'CONFIRM' | 'EXECUTE' | 'REJECT' | 'ADVISORY';
};

type DecisionChain = {
  feeds: string;
  ohlc: string;
  regime: string;
  setup: string | null;
  action: string;
};

type BoardMeta = {
  regimes: string[];
  trade_types: string[];
  active_regimes: string[];
  feed_sender_count: number;
  feed_contributing: number;
  chain: string;
  note?: string;
};

type DataSender = {
  sender_id: string;
  name: string;
  kind: string;
  status: string;
  trust: string;
  environment: string;
  latency_ms: number | null;
  enabled?: boolean;
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
  trading_enabled: boolean;
  started_at: string;
  stopped_at: string | null;
  ticks: RobotTick[];
  last_quote_at: string | null;
  last_mid: number | null;
  last_deal_reference: string | null;
  deal_id: string | null;
  entry_price: number | null;
  entry_at: string | null;
  mfe: number;
  mae: number;
  peak_retention: number | null;
  unrealized: number | null;
  mode: 'FLAT' | 'MANAGE' | 'ENTRY';
  regime?: string;
  tape_dir?: 'BUY' | 'SELL' | null;
  tape_reason?: string | null;
  feed_source?: 'MULTI' | 'LOCAL' | 'NONE';
  feed_contributing?: number;
  feed_sender_count?: number;
  feed_agreement?: string | null;
  feed_legs?: FeedLeg[];
  zone_info?: string | null;
  regime_info?: string | null;
  market_status?: string | null;
  market_tradeable?: boolean;
  market_info?: string | null;
  zone_high?: number | null;
  zone_low?: number | null;
  zone_kind?: string | null;
  decision_chain?: DecisionChain;
  ohlc_10s?: {
    last_o: number | null;
    last_h: number | null;
    last_l: number | null;
    last_c: number | null;
    forming_c: number | null;
    body_pct: number | null;
    market: 'MOVING' | 'QUIET' | 'SEEDING';
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

/** FLAT shows "—" today — users think robot opens naked. SL is always sent with entry. */
function fmtSl(s: RobotSession): string {
  if (s.safety_sl != null && Number.isFinite(s.safety_sl)) {
    return fmt(s.safety_sl, 2);
  }
  if (s.open_side) return 'MISSING — check Capital.com';
  return 'AUTO @ entry (~0.20%)';
}

function posture(s: RobotSession): { label: string; kind: 'long' | 'short' | 'flat' | 'entry' | 'closed' } {
  if (!s.running && !s.open_side) return { label: 'STOPPED', kind: 'flat' };
  if (s.running && s.market_tradeable === false) {
    const st = (s.market_status || 'CLOSED').toUpperCase();
    return { label: `MARKET CLOSED · ${st}`, kind: 'closed' };
  }
  if (s.open_side === 'BUY') {
    return { label: 'BUY', kind: 'long' };
  }
  if (s.open_side === 'SELL') {
    return { label: 'SELL', kind: 'short' };
  }
  if (s.running && !s.open_side) {
    const dir = (s.tape_dir || '').toUpperCase();
    if (dir === 'BUY') return { label: 'READY BUY', kind: 'entry' };
    if (dir === 'SELL') return { label: 'READY SELL', kind: 'entry' };
    return { label: 'SCAN · TAPE FLAT', kind: 'entry' };
  }
  return { label: 'FLAT', kind: 'flat' };
}

function lastLog(s: RobotSession): string {
  const t = s.ticks?.[0];
  if (!t) return 'Booting…';
  return t.detail;
}

export function RobotDeskPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<RobotSession[]>([]);
  const [board, setBoard] = useState<BoardMeta | null>(null);
  const [senders, setSenders] = useState<DataSender[]>([]);
  const [focusId, setFocusId] = useState<string | null>(params.get('id'));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [booted, setBooted] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);

  const [launchAccounts, setLaunchAccounts] = useState<
    {
      account_id: number;
      client_name: string;
      broker_name: string;
      environment: string;
      capital_market_count?: number;
    }[]
  >([]);
  const [launchAccountId, setLaunchAccountId] = useState<number | null>(null);
  const [launchMarkets, setLaunchMarkets] = useState<
    {
      instrument_id: number;
      epic?: string;
      symbol: string;
      display_name: string;
      lot_size: number;
      min_lot: number;
    }[]
  >([]);
  const [launchFilter, setLaunchFilter] = useState('');
  const [launchEpic, setLaunchEpic] = useState('');
  const [launchLot, setLaunchLot] = useState('0.1');
  const [showDeploy, setShowDeploy] = useState(false);

  const accountId = params.get('account_id');
  const epic = params.get('epic');
  const lot = params.get('lot');
  const name = params.get('name');

  const refresh = useCallback(async () => {
    try {
      const list = await apiFetch<{
        sessions: RobotSession[];
        board?: BoardMeta;
        senders?: DataSender[];
      }>('/api/robot-desk');
      const rows = list.sessions || [];
      setSessions(rows);
      setBoard(list.board || null);
      setSenders(list.senders || []);
      setError(null);
      setFocusId((prev) => {
        if (prev && rows.some((r) => r.id === prev)) return prev;
        return rows.find((r) => r.running)?.id || rows[0]?.id || null;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Board sync failed');
    }
  }, []);

  // Auto-start from query once, then stay on board
  useEffect(() => {
    if (booted) return;
    if (accountId && epic && lot) {
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
          setFocusId(res.session.id);
          navigate('/robot', { replace: true });
        })
        .catch((e) => setError(e instanceof Error ? e.message : 'Start failed'))
        .finally(() => {
          setBusy(false);
          void refresh();
        });
      return;
    }
    setBooted(true);
    void refresh();
  }, [booted, accountId, epic, lot, name, navigate, refresh]);

  useEffect(() => {
    const t = setInterval(() => void refresh(), 2000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    void apiFetch<typeof launchAccounts>('/api/trading/accounts')
      .then((rows) => {
        setLaunchAccounts(rows || []);
        if (!launchAccountId && rows?.[0]) setLaunchAccountId(rows[0].account_id);
      })
      .catch(() => setLaunchAccounts([]));
  }, [launchAccountId]);

  useEffect(() => {
    if (!launchAccountId) return;
    void apiFetch<typeof launchMarkets>(`/api/trading/accounts/${launchAccountId}/instruments`)
      .then((rows) => {
        setLaunchMarkets(rows || []);
        if (rows?.[0]) {
          setLaunchEpic(rows[0].epic || rows[0].symbol);
          setLaunchLot(String(rows[0].lot_size || rows[0].min_lot || 0.1));
        }
      })
      .catch(() => setLaunchMarkets([]));
  }, [launchAccountId]);

  const filteredLaunch = useMemo(() => {
    const q = launchFilter.trim().toLowerCase();
    if (!q) return launchMarkets.slice(0, 200);
    return launchMarkets
      .filter(
        (m) =>
          m.display_name.toLowerCase().includes(q) ||
          (m.epic || m.symbol).toLowerCase().includes(q),
      )
      .slice(0, 200);
  }, [launchMarkets, launchFilter]);

  const view = params.get('view') === 'info' ? 'info' : 'command';
  const setView = (next: 'command' | 'info') => {
    const q = new URLSearchParams(params);
    if (next === 'info') q.set('view', 'info');
    else q.delete('view');
    navigate({ pathname: '/robot', search: q.toString() ? `?${q}` : '' }, { replace: true });
  };

  const focused = sessions.find((s) => s.id === focusId) || null;
  const runningCount = sessions.filter((s) => s.running).length;
  const regimes = board?.regimes?.length ? board.regimes : [...ALL_REGIMES];
  const activeRegimes = new Set(
    (board?.active_regimes?.length
      ? board.active_regimes
      : sessions.filter((s) => s.running).map((s) => s.regime || 'UNKNOWN')
    ).map((r) => r.toUpperCase()),
  );
  const capitalSenders = senders.filter(
    (s) => s.kind === 'capital_com' && s.enabled !== false,
  );
  const publicSenders = senders.filter(
    (s) =>
      s.kind === 'yahoo_finance' ||
      s.kind === 'aurum_metals' ||
      s.kind === 'fx_live' ||
      s.kind === 'coinbase' ||
      s.kind === 'fx_reference',
  );
  const feedCount = board?.feed_sender_count ?? capitalSenders.length + publicSenders.length;
  const feedOk = board?.feed_contributing ?? 0;
  const chainLabel =
    board?.chain || 'LEAD/CONFIRM near Capital → 10s OHLC → ZONE → REGIME → ENTRY/EXIT';
  const boardNote =
    board?.note ||
    'Public feeds only count when NEAR Capital CFD mid — FAR = REJECT, wrong epic = N/A (not IDLE broken)';
  const tradeTypes = board?.trade_types || ['BUY LONG', 'SELL LONG', 'BUY SCALP', 'SELL SCALP'];
  const focusLegs = focused?.feed_legs || [];
  const focusChain = focused?.decision_chain;
  const focusPosture = focused ? posture(focused) : null;
  const clock = new Date().toLocaleTimeString();
  const nowDate = new Date().toLocaleDateString();

  function publicFeedRow(s: (typeof publicSenders)[0]) {
    const epic = (focused?.epic || focused?.display_name || '').toUpperCase();
    const isMetal = /GOLD|XAU|SILVER|XAG|PLAT|XPT|PALL|XPD/.test(epic);
    const isCrypto = /BTC|ETH|BITCOIN|ETHEREUM/.test(epic);
    const isFx =
      epic.length >= 6 &&
      !isMetal &&
      !isCrypto &&
      /^[A-Z]{6}/.test(epic.replace(/[^A-Z]/g, ''));
    let na: string | null = null;
    if (epic) {
      if ((s.kind === 'fx_reference' || s.kind === 'fx_live') && (isMetal || isCrypto)) {
        na = 'N/A · not FX epic';
      } else if (s.kind === 'coinbase' && !isCrypto) {
        na = 'N/A · crypto only';
      } else if (s.kind === 'aurum_metals' && !isMetal) {
        na = 'N/A · metals only';
      } else if (s.kind === 'yahoo_finance' && isFx && !isMetal) {
        /* yahoo may still map FX — leave */
      }
    }
    const leg =
      focusLegs.find(
        (l) =>
          l.sender_id === s.sender_id ||
          (l.name || '').toLowerCase().includes((s.name || '').toLowerCase().slice(0, 8)) ||
          (l.name || '').toLowerCase().includes(String(s.kind || '').replace(/_/g, ' '))
      ) || null;
    if (na) {
      return { status: 'N/A', detail: na, okClass: false, warnClass: true };
    }
    if (leg?.role === 'REJECT') {
      return {
        status: 'REJECT FAR',
        detail: leg.detail || 'far from Capital',
        okClass: false,
        warnClass: false,
      };
    }
    if (leg?.role === 'LEAD' || leg?.role === 'CONFIRM') {
      return {
        status: `${leg.role} · LIVE`,
        detail: leg.detail || '',
        okClass: true,
        warnClass: false,
      };
    }
    const live = s.status === 'LIVE' || s.status === 'ok' || s.status === 'live';
    return {
      status: String(s.status || 'IDLE'),
      detail: '',
      okClass: live,
      warnClass: !live,
    };
  }
  const deploy = () => {
    if (!launchAccountId || !launchEpic) {
      setError('Izvēlies account + tirgu');
      return;
    }
    const lotN = Number(launchLot);
    if (!Number.isFinite(lotN) || lotN <= 0) {
      setError('Lot > 0');
      return;
    }
    const m = launchMarkets.find((x) => (x.epic || x.symbol) === launchEpic);
    setBusy(true);
    setError(null);
    void apiFetch<{ session: RobotSession }>('/api/robot-desk/start', {
      method: 'POST',
      body: JSON.stringify({
        account_id: launchAccountId,
        epic: launchEpic,
        display_name: m?.display_name || launchEpic,
        lot_size: lotN,
        trading_enabled: true,
      }),
    })
      .then((res) => {
        setFocusId(res.session.id);
        setShowDeploy(false);
        void refresh();
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Deploy failed'))
      .finally(() => setBusy(false));
  };

  const startOne = async (s: RobotSession) => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ session: RobotSession }>('/api/robot-desk/start', {
        method: 'POST',
        body: JSON.stringify({
          account_id: s.account_id,
          epic: s.epic,
          display_name: s.display_name,
          lot_size: s.lot_size,
          trading_enabled: true,
        }),
      });
      setFocusId(res.session.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Start failed');
    } finally {
      setBusy(false);
    }
  };

  const stopOne = async (s: RobotSession) => {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/robot-desk/${encodeURIComponent(s.id)}/stop`, {
        method: 'POST',
        body: JSON.stringify({ account_id: s.account_id, epic: s.epic }),
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Stop failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rc-shell" ref={shellRef}>
      <aside className="rc-rail">
        <div className="rc-rail-brand">
          <Logo size={54} wordmark />
        </div>
        <nav className="rc-rail-nav">
          <Link className={view === 'command' ? 'active' : ''} to="/robot" onClick={(e) => { e.preventDefault(); setView('command'); }}>
            COMMAND
          </Link>
          <button type="button" className={view === 'info' ? 'active' : ''} onClick={() => setView('info')}>
            INFO
          </button>
          <Link to="/market">REGIMES</Link>
          <Link to="/feeds">FEEDS</Link>
          <Link to="/trading">EXECUTION</Link>
          <Link to="/settings">SETTINGS</Link>
        </nav>
        <div className="rc-rail-meta mono">
          <div>{nowDate}</div>
          <div>{clock}</div>
        </div>
      </aside>

      <div className="rc-main">
        <header className="rc-top">
          <div className="rc-title-block">
            <div className="robot-arena-kicker">VS SYSTEM // MULTI-CLIENT BOARD</div>
            <h1 className="rc-title">ROBOT COMMAND</h1>
          </div>
          <div className="rc-stats">
            <div className="rc-stat"><span>UNITS</span><strong>{sessions.length}</strong></div>
            <div className="rc-stat"><span>ONLINE</span><strong>{runningCount}</strong></div>
            <div className="rc-stat"><span>FEEDS</span><strong>{feedOk}/{feedCount || '—'}</strong></div>
            <div className="rc-stat"><span>REGIMES</span><strong>{regimes.length}</strong></div>
          </div>
          <div className="rc-actions">
            <button className="btn btn-primary" type="button" onClick={() => setShowDeploy((v) => !v)}>
              {showDeploy ? 'CLOSE' : '+ DEPLOY'}
            </button>
            <button className="btn" type="button" onClick={() => setView(view === 'info' ? 'command' : 'info')}>
              {view === 'info' ? '← COMMAND' : 'INFO →'}
            </button>
            <Link className="btn" to="/">← BASE</Link>
          </div>
        </header>

        {error && <div className="error-state rc-banner">{error}</div>}
        {busy && <div className="mono rc-banner rc-busy">Syncing combat units…</div>}

        {showDeploy && (
          <div className="rc-deploy">
            <div className="section-title">DEPLOY CLIENT ROBOT</div>
            <div className="actions" style={{ marginTop: 8, flexWrap: 'wrap' }}>
              <select
                className="input"
                style={{ maxWidth: 280 }}
                value={launchAccountId ?? ''}
                onChange={(e) => setLaunchAccountId(Number(e.target.value))}
              >
                {launchAccounts.map((a) => (
                  <option key={a.account_id} value={a.account_id}>
                    {a.client_name} · #{a.account_id} ({a.environment})
                  </option>
                ))}
              </select>
              <input
                className="input"
                style={{ maxWidth: 160 }}
                placeholder="Search market…"
                value={launchFilter}
                onChange={(e) => setLaunchFilter(e.target.value)}
              />
              <select
                className="input"
                style={{ maxWidth: 280 }}
                value={launchEpic}
                onChange={(e) => {
                  setLaunchEpic(e.target.value);
                  const m = launchMarkets.find((x) => (x.epic || x.symbol) === e.target.value);
                  if (m) setLaunchLot(String(m.lot_size || m.min_lot || 0.1));
                }}
              >
                {filteredLaunch.map((m) => (
                  <option key={m.instrument_id} value={m.epic || m.symbol}>
                    {m.display_name} · {m.epic || m.symbol}
                  </option>
                ))}
              </select>
              <input
                className="input"
                style={{ maxWidth: 80 }}
                value={launchLot}
                onChange={(e) => setLaunchLot(e.target.value)}
              />
              <button className="btn btn-go" type="button" disabled={busy} onClick={deploy}>
                DEPLOY
              </button>
            </div>
          </div>
        )}

        {view === 'command' ? (
          <>
            <section className="rc-regimes" aria-label="Tape chain">
              <div className="robot-arena-kicker">TAPE CHAIN · 25/10/5/1</div>
              <div className="robot-wire-regimes">
                {regimes.map((r) => {
                  const name = r.toUpperCase();
                  const parked = focused?.market_tradeable === false;
                  const live = !parked && activeRegimes.has(name);
                  const focusHit =
                    !parked && (focused?.regime || '').toUpperCase() === name;
                  return (
                    <span
                      key={name}
                      className={`robot-regime-chip ${live ? 'live' : ''} ${focusHit ? 'focus' : ''} ${parked ? 'parked' : ''}`}
                      title={
                        parked
                          ? 'Robot PARKED — market closed'
                          : live
                            ? 'Active tape side'
                            : 'Tape state'
                      }
                    >
                      {name}
                    </span>
                  );
                })}
              </div>
            </section>

            <section className="rc-stage">
              <div className="rc-units">
                {sessions.length === 0 && !busy && (
                  <div className="rc-empty">
                    <div className="robot-arena-kicker">EMPTY BOARD</div>
                    <p>Nav robotu. Spied + DEPLOY.</p>
                    <button className="btn btn-primary" type="button" onClick={() => setShowDeploy(true)}>
                      + DEPLOY
                    </button>
                  </div>
                )}
                {sessions.map((s) => {
                  const p = posture(s);
                  const active = focusId === s.id;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      className={`rc-unit ${p.kind} ${s.running ? 'on' : 'off'} ${active ? 'active' : ''}`}
                      onClick={() => setFocusId(s.id)}
                    >
                      <div className="rc-unit-head">
                        <span>{(s.client_name || s.account_name).toUpperCase()}</span>
                        <span className={`robot-mini-dot ${s.running ? 'on' : 'off'}`} />
                      </div>
                      <div className="rc-unit-market">{s.display_name}</div>
                      <div className={`rc-unit-posture ${p.kind}`}>{p.label}</div>
                      <div className="rc-unit-row mono">
                        <span>MID</span>
                        <strong>{fmt(s.last_mid)}</strong>
                      </div>
                      <div className="rc-unit-row mono">
                        <span>UPL</span>
                        <strong className={(s.unrealized || 0) >= 0 ? 'pos' : 'neg'}>{fmt(s.unrealized)}</strong>
                      </div>
                    </button>
                  );
                })}
              </div>

              <div className="rc-focus">
                {focused ? (
                  <>
                    <div className="rc-focus-head">
                      <div>
                        <div className="robot-arena-kicker">FOCUS UNIT</div>
                        <div className="rc-focus-name">
                          {(focused.client_name || focused.account_name).toUpperCase()} · {focused.display_name}
                        </div>
                        <div className={`rc-unit-posture ${focusPosture?.kind || 'flat'}`}>
                          {focusPosture?.label}
                        </div>
                      </div>
                      <div className="robot-ctrl robot-ctrl-lg">
                        <button
                          type="button"
                          className="btn btn-go"
                          disabled={busy || focused.running}
                          onClick={() => void startOne(focused)}
                        >
                          START
                        </button>
                        <button
                          type="button"
                          className="btn btn-stop"
                          disabled={busy || !focused.running}
                          onClick={() => void stopOne(focused)}
                        >
                          STOP
                        </button>
                      </div>
                    </div>
                    <div className="rc-focus-metrics mono">
                      <div><span>MID</span><strong>{fmt(focused.last_mid)}</strong></div>
                      <div><span>10s</span><strong>{focused.ohlc_10s?.market || 'SEEDING'}</strong></div>
                      <div><span>FEEDS</span><strong>{focused.feed_contributing ?? 0}/{focused.feed_sender_count ?? 0}</strong></div>
                      <div title="Safety SL on Capital.com — set automatically on every entry when flat">
                        <span>SL</span><strong>{fmtSl(focused)}</strong>
                      </div>
                      <div><span>UPL</span><strong className={(focused.unrealized || 0) >= 0 ? 'pos' : 'neg'}>{fmt(focused.unrealized)}</strong></div>
                      <div><span>LOT</span><strong>{focused.lot_size}</strong></div>
                    </div>
                    <div className="rc-focus-log mono">{lastLog(focused)}</div>
                    <button type="button" className="btn rc-more" onClick={() => setView('info')}>
                      FULL DETAIL → INFO
                    </button>
                  </>
                ) : (
                  <div className="rc-empty">
                    <div className="robot-arena-kicker">NO FOCUS</div>
                    <p>Deploy or select a unit.</p>
                  </div>
                )}
              </div>

              <div className="rc-emblem" aria-hidden>
                <Logo size={120} />
                <div className="rc-emblem-ring" />
                <div className="mono rc-emblem-tag">PRECISION · CONTROL · EXECUTION</div>
              </div>
            </section>
          </>
        ) : (
          <section className="rc-info">
            <div className="rc-info-col">
              <div className="robot-arena-kicker">WIRED CHAIN</div>
              <p className="mono rc-info-text">{chainLabel}</p>
              <p className="mono rc-info-text">{boardNote}</p>
              <div className="robot-arena-kicker" style={{ marginTop: 10 }}>TRADE TYPES</div>
              <p className="mono rc-info-text">{tradeTypes.join(' · ')}</p>

              <div className="robot-arena-kicker" style={{ marginTop: 14 }}>OPTIONAL PUBLIC REFERENCE (never blocks trade)</div>
              <div className="robot-feed-legs">
                {publicSenders.map((s) => {
                  const row = publicFeedRow(s);
                  return (
                    <div
                      key={s.sender_id}
                      className={`robot-feed-leg ${row.okClass ? 'ok' : ''} ${row.warnClass ? 'warn' : ''} ${
                        row.status.startsWith('REJECT') ? 'bad' : ''
                      }`}
                    >
                      <strong>{s.name}</strong>
                      <span className="mono">
                        {s.kind} · {row.status} · {s.trust}
                        {s.latency_ms != null && row.okClass ? ` · ${s.latency_ms}ms` : ''}
                        {row.detail ? ` · ${row.detail}` : ''}
                      </span>
                    </div>
                  );
                })}
                {publicSenders.length === 0 && <div className="mono robot-wire-empty">Nav public feeds.</div>}
              </div>

              <div className="robot-arena-kicker" style={{ marginTop: 14 }}>CAPITAL BROKER FEEDS (real — LEAD/CONFIRM/EXECUTE)</div>
              <div className="robot-feed-legs">
                {capitalSenders.map((s) => (
                  <div
                    key={s.sender_id}
                    className={`robot-feed-leg ${s.status === 'LIVE' || s.status === 'ok' || s.status === 'live' ? 'ok' : ''}`}
                  >
                    <strong>{s.name}</strong>
                    <span className="mono">
                      {s.kind} · {s.status} · {s.trust}
                      {s.latency_ms != null ? ` · ${s.latency_ms}ms` : ''}
                    </span>
                  </div>
                ))}
                {capitalSenders.length === 0 && (
                  <div className="mono robot-wire-empty">Nav enabled Capital — Brokers.</div>
                )}
              </div>
            </div>

            <div className="rc-info-col">
              <div className="robot-arena-kicker">FOCUS DETAIL</div>
              {focused ? (
                <div className="mono rc-info-text" style={{ lineHeight: 1.7 }}>
                  <div>STATUS · {focused.running ? 'ONLINE' : 'STOPPED'}</div>
                  <div>ID · {focused.id}</div>
                  <div>ACCOUNT · {focused.account_name}</div>
                  <div>POSTURE · {posture(focused).label}</div>
                  {focused.market_tradeable === false && (
                    <div className="robot-market-closed">{focused.market_info || `MARKET CLOSED · ${focused.market_status || 'CLOSED'}`}</div>
                  )}
                  <div>
                    CHAIN ·{' '}
                    {focusChain
                      ? `${focusChain.feeds} → ${focusChain.ohlc} → ${focusChain.regime} → ${focusChain.action}`
                      : chainLabel}
                  </div>
                  <div>
                    10s OHLC · O {fmt(focused.ohlc_10s?.last_o, 2)} H {fmt(focused.ohlc_10s?.last_h, 2)} L{' '}
                    {fmt(focused.ohlc_10s?.last_l, 2)} C {fmt(focused.ohlc_10s?.last_c, 2)} ·{' '}
                    {focused.ohlc_10s?.market || 'SEEDING'}
                  </div>
                  <div>MODE · {focused.running ? focused.mode : 'STOPPED'}</div>
                  <div>{focused.tape_reason || focused.regime_info || `TAPE · ${focused.tape_dir || 'FLAT'}`}</div>
                  <div>{focused.zone_info || 'ZONE · forming'}</div>
                  <div>
                    FEEDS ·{' '}
                    {focusChain?.feeds ||
                      `cap ${focused.feed_contributing ?? 0}/${focused.feed_sender_count ?? 0} · ${
                        focused.feed_agreement || ''
                      } · ${focused.feed_source || '—'}`}
                  </div>
                  {focusLegs.length > 0 && (
                    <div className="robot-focus-legs">
                      {focusLegs.map((leg) => (
                        <div key={leg.sender_id} className={leg.ok ? 'ok' : 'bad'}>
                          {leg.role ? `[${leg.role}] ` : ''}
                          {leg.name} · {leg.ok ? fmt(leg.mid, 2) : 'FAIL'} · {leg.latency_ms}ms
                          {leg.detail ? ` · ${leg.detail}` : ''}
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="robot-focus-legs" style={{ marginTop: 10 }}>
                    <div style={{ opacity: 0.7, marginBottom: 4 }}>LIVE TICKS (what is really happening)</div>
                    {(focused.ticks || []).slice(0, 8).map((t, i) => (
                      <div key={`${t.at}-${i}`}>
                        {t.phase} · {t.detail}
                      </div>
                    ))}
                  </div>
                  <div>ENTRY · {fmt(focused.entry_price)}</div>
                  <div>SAFETY SL · {fmtSl(focused)}</div>
                  <div>DEAL · {focused.deal_id || '—'}</div>
                  <div>SCORE · IN {focused.orders_placed} / OUT {focused.exits_done ?? 0}</div>
                  <div>READS · {focused.reads_ok}/{focused.reads_fail}</div>
                  {focused.error && <div className="error-state" style={{ marginTop: 8 }}>{focused.error}</div>}
                </div>
              ) : (
                <div className="mono robot-wire-empty">Nav focus unit.</div>
              )}
            </div>

            <div className="rc-info-col rc-info-log">
              <div className="robot-arena-kicker">SYSTEM LOG</div>
              <div className="robot-feed">
                {(focused?.ticks || []).slice(0, 60).map((t, i) => (
                  <div key={`${t.at}-${i}`} className={`robot-feed-line phase-${t.phase.toLowerCase()}`}>
                    <span className="mono time">{new Date(t.at).toLocaleTimeString()}</span>
                    <span className="badge phase">{t.phase}</span>
                    <span className="detail">{t.detail}</span>
                  </div>
                ))}
                {(!focused || focused.ticks.length === 0) && <div className="mono">Waiting for feed…</div>}
              </div>
            </div>
          </section>
        )}

        <footer className="rc-motto">PRECISION · CONTROL · EXECUTION</footer>
      </div>
    </div>
  );
}

/** Start robot and open/focus the shared multi-client board (one page). */
export function openRobotWindow(opts: {
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
  // Same tab board — all clients visible together
  window.location.href = `/robot?${q.toString()}`;
  return null;
}
