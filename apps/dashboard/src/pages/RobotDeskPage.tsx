import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
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

const ALL_REGIMES = [
  'UNKNOWN',
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

/** Catalog shown on the board — UNKNOWN is seeding only, not a trade mode. */
const BOARD_REGIMES = ALL_REGIMES.filter((r) => r !== 'UNKNOWN');

type FeedLeg = {
  sender_id: string;
  name: string;
  ok: boolean;
  mid: number | null;
  latency_ms: number;
  detail?: string;
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
  git_sha?: string;
  entry_brain?: string;
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
  capital_market_status?: string | null;
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
  trend_bias?: 'UP' | 'DOWN' | 'FLAT';
  feed_source?: 'MULTI' | 'LOCAL' | 'NONE';
  feed_contributing?: number;
  feed_sender_count?: number;
  feed_agreement?: string | null;
  feed_legs?: FeedLeg[];
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

function displayRegime(s: Pick<RobotSession, 'regime' | 'trend_bias' | 'ohlc_10s'>): string {
  const r = String(s.regime || '').toUpperCase();
  if (r && r !== 'UNKNOWN') return r;
  if (s.trend_bias === 'UP') return 'TREND_UP';
  if (s.trend_bias === 'DOWN') return 'TREND_DOWN';
  if (s.ohlc_10s?.market === 'SEEDING') return 'SEEDING';
  return 'SEEDING';
}

function fmt(n: number | null | undefined, d = 5) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, { maximumFractionDigits: d });
}

function posture(s: RobotSession): { label: string; kind: 'long' | 'short' | 'flat' | 'entry' } {
  const regime = displayRegime(s);
  if (!s.running && !s.open_side) return { label: `STOPPED · ${regime}`, kind: 'flat' };
  if (s.open_side === 'BUY' || s.open_side === 'SELL') {
    const t = tradeLabel(s);
    return { label: `${t} · ${regime}`, kind: t.includes('SCALP') ? 'short' : 'long' };
  }
  if (s.running && !s.open_side) {
    const fade =
      regime === 'RANGE' ||
      regime === 'FAILED_BREAKOUT_UP' ||
      regime === 'FAILED_BREAKOUT_DOWN' ||
      regime === 'REVERSAL_CANDIDATE' ||
      regime === 'COMPRESSION' ||
      regime === 'TRANSITION' ||
      regime === 'SEEDING';
    if (fade && regime !== 'SEEDING') return { label: `WAIT · ${regime} · no fade`, kind: 'entry' };
    if (regime === 'SEEDING') return { label: 'WAIT · SEEDING 10s', kind: 'entry' };
    const bias = String(s.trend_bias || s.decision_chain?.setup || '').toUpperCase();
    const only =
      bias.includes('UP') ? ' · bias UP · only BUY' : bias.includes('DOWN') ? ' · bias DOWN · only SELL' : ' · with-trend';
    return { label: `WAIT · ${regime}${only}`, kind: 'entry' };
  }
  return { label: `FLAT · ${regime}`, kind: 'flat' };
}

function tradeLabel(s: RobotSession): string {
  if (!s.open_side) return 'FLAT';
  const r = (s.regime || '').toUpperCase();
  const side = String(s.open_side).toUpperCase();
  if (r === 'TREND_UP' || r === 'PULLBACK_UPTREND') {
    return side === 'BUY' ? 'BUY LONG' : 'SELL SCALP';
  }
  if (r === 'TREND_DOWN' || r === 'PULLBACK_DOWNTREND') {
    return side === 'SELL' ? 'SELL LONG' : 'BUY SCALP';
  }
  const scalp =
    r === 'BREAKOUT_UP' ||
    r === 'BREAKOUT_DOWN' ||
    r === 'FAILED_BREAKOUT_UP' ||
    r === 'FAILED_BREAKOUT_DOWN' ||
    r === 'COMPRESSION' ||
    r === 'EXPANSION' ||
    r === 'RANGE' ||
    r === 'REVERSAL_CANDIDATE' ||
    r === 'TRANSITION';
  if (scalp) return `${side} SCALP`;
  return side;
}

function lastLog(s: RobotSession): string {
  const t = s.ticks?.[0];
  if (!t) return 'Booting…';
  return t.detail;
}

function senderLive(s: DataSender): boolean {
  const st = String(s.status || '').toLowerCase();
  return st === 'live' || st === 'ok';
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
  const [showDeploy, setShowDeploy] = useState(true);
  const [isFs, setIsFs] = useState(false);
  const [shellH, setShellH] = useState<number | null>(null);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

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
    const onFs = () => setIsFs(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  useEffect(() => {
    if (sessions.length === 0) setShowDeploy(true);
  }, [sessions.length]);

  const goFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        await (shellRef.current || document.documentElement).requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch {
      setError('Spied F11 pārlūkā — pilnekrāns');
    }
  };

  const onResizeDown = (ev: ReactPointerEvent<HTMLDivElement>) => {
    ev.preventDefault();
    const el = shellRef.current;
    if (!el) return;
    const startH = shellH ?? el.getBoundingClientRect().height;
    dragRef.current = { startY: ev.clientY, startH };
    ev.currentTarget.setPointerCapture(ev.pointerId);
  };

  const onResizeMove = (ev: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const next = Math.max(480, d.startH + (ev.clientY - d.startY));
    setShellH(next);
  };

  const onResizeUp = (ev: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    try {
      ev.currentTarget.releasePointerCapture(ev.pointerId);
    } catch {
      /* already released */
    }
  };

  useEffect(() => {
    if (!launchAccountId) return;
    void apiFetch<typeof launchMarkets>(`/api/trading/accounts/${launchAccountId}/instruments`)
      .then((rows) => {
        const list = rows || [];
        setLaunchMarkets(list);
        const gold =
          list.find((m) => /gold|xau/i.test(`${m.display_name} ${m.epic || ''} ${m.symbol}`)) ||
          list[0];
        if (gold) {
          setLaunchEpic(gold.epic || gold.symbol);
          setLaunchLot(String(gold.lot_size || gold.min_lot || 0.1));
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

  const focused = sessions.find((s) => s.id === focusId) || null;
  const runningCount = sessions.filter((s) => s.running).length;
  const activeRegimes = new Set(
    (board?.active_regimes?.length
      ? board.active_regimes
      : sessions.filter((s) => s.running).map((s) => displayRegime(s))
    )
      .map((r) => r.toUpperCase())
      .filter((r) => r && r !== 'UNKNOWN' && r !== 'SEEDING'),
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
    board?.chain || 'PUBLIC INTERNET + Capital → consensus mid → 10s OHLC → REGIME → ENTRY/EXIT';
  const tradeTypes = board?.trade_types || ['BUY LONG', 'SELL LONG', 'BUY SCALP', 'SELL SCALP'];
  const focusLegs = focused?.feed_legs || [];
  const focusChain = focused?.decision_chain;
  const focusPosture = focused ? posture(focused) : null;

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
    <div
      className={`robot-fs-shell robot-board-shell robot-onepage${shellH ? ' robot-fs-resized' : ''}`}
      ref={shellRef}
      style={shellH ? { height: shellH, minHeight: shellH } : undefined}
    >
      <div className="robot-desk robot-desk-fs robot-board robot-board-one">
        <header className="robot-op-top">
          <div className="robot-op-brand">
            <Logo size={56} wordmark />
            <div className="robot-op-brand-copy">
              <div className="robot-arena-kicker">
                VS SYSTEM // BUILD {board?.git_sha || '…'} // NODE BRAIN
              </div>
              <h1 className="robot-op-title">VS ROBOT</h1>
              <p className="robot-op-sub">
                WITH-TREND · kāpums = BUY · kritums = SELL · RANGE negaidā fade
              </p>
            </div>
          </div>
          <div className="robot-op-stats">
            <div className="robot-mode-banner entry">
              <div className="label">UNITS</div>
              <div className="value">{sessions.length}</div>
            </div>
            <div className={`robot-mode-banner ${runningCount ? 'manage' : 'flat'}`}>
              <div className="label">ONLINE</div>
              <div className="value">{runningCount}</div>
            </div>
            <div className={`robot-mode-banner ${feedCount ? 'manage' : 'flat'}`}>
              <div className="label">FEEDS</div>
              <div className="value">
                {feedOk}/{feedCount || '—'}
              </div>
            </div>
          </div>
          <div className="robot-op-actions actions">
            <button className="btn btn-primary" type="button" onClick={() => void goFullscreen()}>
              {isFs ? 'EXIT FS' : 'PILNEKRĀNS'}
            </button>
            <button className="btn btn-primary" type="button" onClick={() => setShowDeploy((v) => !v)}>
              {showDeploy ? 'CLOSE DEPLOY' : '+ DEPLOY'}
            </button>
            <Link className="btn" to="/">
              ← BASE
            </Link>
          </div>
        </header>

        {error && <div className="error-state robot-op-alert">{error}</div>}
        {busy && <div className="mono robot-op-busy">Syncing…</div>}

        {showDeploy && (
          <div className="robot-op-deploy">
            <div className="robot-arena-kicker">DEPLOY CLIENT ROBOT</div>
            <div className="actions robot-op-deploy-row">
              <select
                className="input"
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
                placeholder="Search market…"
                value={launchFilter}
                onChange={(e) => setLaunchFilter(e.target.value)}
              />
              <select
                className="input"
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
                className="input robot-op-lot"
                value={launchLot}
                onChange={(e) => setLaunchLot(e.target.value)}
              />
              <button className="btn btn-go" type="button" disabled={busy} onClick={deploy}>
                DEPLOY
              </button>
            </div>
          </div>
        )}

        <div className="robot-op-body">
          <aside className="robot-op-rail">
            <section className="robot-op-section">
              <div className="robot-arena-kicker">REGIMES</div>
              <div className="robot-op-regimes">
                {BOARD_REGIMES.map((r) => {
                  const nameR = r.toUpperCase();
                  const live = activeRegimes.has(nameR);
                  const focusHit =
                    displayRegime(focused || { regime: '', trend_bias: 'FLAT' }) === nameR;
                  return (
                    <span
                      key={nameR}
                      className={`robot-regime-chip ${live ? 'live' : ''} ${focusHit ? 'focus' : ''}`}
                    >
                      {nameR}
                    </span>
                  );
                })}
              </div>
              <div className="robot-op-trades">
                {tradeTypes.map((t) => (
                  <span key={t} className="robot-trade-chip">
                    {t}
                  </span>
                ))}
              </div>
            </section>

            <section className="robot-op-section">
              <div className="robot-arena-kicker">PUBLIC FEEDS</div>
              <div className="robot-op-feedlist">
                {publicSenders.length === 0 && (
                  <div className="mono robot-wire-empty">Nav public senders</div>
                )}
                {publicSenders.map((s) => (
                  <div key={s.sender_id} className={`robot-op-feed ${senderLive(s) ? 'ok' : 'idle'}`}>
                    <span className="robot-op-feed-dot" />
                    <span className="robot-op-feed-name">{s.name}</span>
                    <span className="mono">
                      {s.status}
                      {s.latency_ms != null ? ` · ${s.latency_ms}ms` : ''}
                    </span>
                  </div>
                ))}
              </div>
            </section>

            <section className="robot-op-section">
              <div className="robot-arena-kicker">CAPITAL</div>
              <div className="robot-op-feedlist">
                {capitalSenders.length === 0 && (
                  <div className="mono robot-wire-empty">Nav Capital — Brokers</div>
                )}
                {capitalSenders.map((s) => (
                  <div key={s.sender_id} className={`robot-op-feed ${senderLive(s) ? 'ok' : 'idle'}`}>
                    <span className="robot-op-feed-dot" />
                    <span className="robot-op-feed-name">{s.name}</span>
                    <span className="mono">
                      {s.status}
                      {s.latency_ms != null ? ` · ${s.latency_ms}ms` : ''}
                    </span>
                  </div>
                ))}
              </div>
            </section>

            <p className="robot-op-chain mono">{chainLabel}</p>
          </aside>

          <main className="robot-op-units">
            {sessions.length === 0 && !busy && (
              <div className="robot-empty robot-op-empty">
                <div className="robot-arena-kicker">EMPTY BOARD</div>
                <p>
                  Units = 0. Izvēlies account + tirgu, spied <b>DEPLOY</b>.
                </p>
                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={() => {
                    setShowDeploy(true);
                    void goFullscreen();
                  }}
                >
                  + DEPLOY FIRST UNIT
                </button>
              </div>
            )}
            <div className="robot-board-grid robot-op-grid">
              {sessions.map((s) => {
                const p = posture(s);
                const active = focusId === s.id;
                return (
                  <div
                    key={s.id}
                    role="button"
                    tabIndex={0}
                    className={`robot-mini ${p.kind} ${s.running ? 'on' : 'off'} ${active ? 'active' : ''}`}
                    onClick={() => setFocusId(s.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setFocusId(s.id);
                      }
                    }}
                  >
                    <div className="robot-mini-head">
                      <span className="robot-mini-client">
                        {(s.client_name || s.account_name).toUpperCase()}
                      </span>
                      <span className={`robot-mini-dot ${s.running ? 'on' : 'off'}`} />
                    </div>
                    <div className="robot-mini-market">{s.display_name}</div>
                    <div className={`robot-mini-posture ${p.kind}`}>{p.label}</div>
                    <div className="robot-mini-regime mono">{displayRegime(s)}</div>
                    <div className="robot-mini-row">
                      <span>CAPITAL</span>
                      <strong
                        className={
                          String(s.capital_market_status || '').toUpperCase() === 'TRADEABLE' ||
                          String(s.capital_market_status || '').toUpperCase() === 'OPEN'
                            ? 'pos'
                            : 'neg'
                        }
                      >
                        {s.capital_market_status || '—'}
                      </strong>
                    </div>
                    <div className="robot-mini-row">
                      <span>MID</span>
                      <strong>{fmt(s.last_mid)}</strong>
                    </div>
                    <div className="robot-mini-row">
                      <span>10s</span>
                      <strong>
                        {s.ohlc_10s?.last_c != null
                          ? `${fmt(s.ohlc_10s.last_o, 2)}→${fmt(s.ohlc_10s.last_c, 2)} ${s.ohlc_10s.market}`
                          : 'SEEDING'}
                      </strong>
                    </div>
                    <div className="robot-mini-row">
                      <span>FEEDS</span>
                      <strong>
                        {s.feed_contributing ?? 0}/{s.feed_sender_count ?? 0} {s.feed_source || '—'}
                      </strong>
                    </div>
                    <div className="robot-mini-row">
                      <span>UPL</span>
                      <strong className={(s.unrealized || 0) >= 0 ? 'pos' : 'neg'}>
                        {fmt(s.unrealized)}
                      </strong>
                    </div>
                    <div className="robot-mini-row">
                      <span>LOT / SL</span>
                      <strong>
                        {s.lot_size} / {fmt(s.safety_sl)}
                      </strong>
                    </div>
                    <div className="robot-mini-mode">
                      {s.running
                        ? s.decision_chain
                          ? `${s.decision_chain.feeds} → ${s.decision_chain.regime} → ${
                              s.decision_chain.setup || s.trend_bias || 'bias —'
                            } → ${s.decision_chain.action}`
                          : `${s.mode} · ${displayRegime(s)}`
                        : 'STOPPED'}
                    </div>
                    {(s.feed_legs?.length ?? 0) > 0 && (
                      <div className="robot-mini-legs mono">
                        {s.feed_legs!.slice(0, 4).map((leg) => (
                          <span key={leg.sender_id} className={leg.ok ? 'ok' : 'bad'}>
                            {leg.name}:
                            {leg.ok
                              ? fmt(leg.mid, 2)
                              : leg.mid != null
                                ? `${fmt(leg.mid, 2)}·FAR`
                                : '×'}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="robot-mini-log mono">{lastLog(s)}</div>
                    <div className="robot-mini-actions">
                      <span className="mono">{s.environment.toUpperCase()}</span>
                      <div className="robot-ctrl" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          className="btn btn-go"
                          disabled={busy || s.running}
                          onClick={() => void startOne(s)}
                        >
                          START
                        </button>
                        <button
                          type="button"
                          className="btn btn-stop"
                          disabled={busy || !s.running}
                          onClick={() => void stopOne(s)}
                        >
                          STOP
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </main>

          <aside className="robot-op-focus robot-hud-panel">
            {focused && focusPosture ? (
              <>
                <div className="robot-board-focus-head">
                  <div>
                    <div className="robot-arena-kicker">FOCUS</div>
                    <div className="robot-op-focus-title">
                      {(focused.client_name || focused.account_name).toUpperCase()}
                    </div>
                    <div className="robot-op-focus-market">{focused.display_name}</div>
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

                <div className={`robot-op-posture ${focusPosture.kind}`}>{focusPosture.label}</div>

                <div className="robot-op-focus-meta mono">
                  <div>
                    <span>STATUS</span>
                    <strong>{focused.running ? 'ONLINE' : 'STOPPED'}</strong>
                  </div>
                  <div>
                    <span>CAPITAL</span>
                    <strong
                      className={
                        String(focused.capital_market_status || '').toUpperCase() === 'TRADEABLE' ||
                        String(focused.capital_market_status || '').toUpperCase() === 'OPEN'
                          ? 'pos'
                          : 'neg'
                      }
                    >
                      {focused.capital_market_status || '—'} · {focused.epic}
                    </strong>
                  </div>
                  <div>
                    <span>MID</span>
                    <strong>{fmt(focused.last_mid)}</strong>
                  </div>
                  <div>
                    <span>REGIME</span>
                    <strong>{displayRegime(focused)}</strong>
                  </div>
                  <div>
                    <span>BIAS</span>
                    <strong>
                      {(focused.trend_bias || 'FLAT').toUpperCase()}
                      {focused.trend_bias === 'UP'
                        ? ' · only BUY'
                        : focused.trend_bias === 'DOWN'
                          ? ' · only SELL'
                          : ''}
                    </strong>
                  </div>
                  <div>
                    <span>10s</span>
                    <strong>
                      O {fmt(focused.ohlc_10s?.last_o, 2)} H {fmt(focused.ohlc_10s?.last_h, 2)} L{' '}
                      {fmt(focused.ohlc_10s?.last_l, 2)} C {fmt(focused.ohlc_10s?.last_c, 2)} ·{' '}
                      {focused.ohlc_10s?.market || 'SEEDING'}
                    </strong>
                  </div>
                  <div>
                    <span>FEEDS</span>
                    <strong>
                      {focused.feed_contributing ?? 0}/{focused.feed_sender_count ?? 0}{' '}
                      {focused.feed_source || '—'}
                    </strong>
                  </div>
                  <div>
                    <span>ENTRY / SL</span>
                    <strong>
                      {fmt(focused.entry_price)} / {fmt(focused.safety_sl)}
                    </strong>
                  </div>
                  <div>
                    <span>SCORE</span>
                    <strong>
                      IN {focused.orders_placed} / OUT {focused.exits_done ?? 0} · R{' '}
                      {focused.reads_ok}/{focused.reads_fail}
                    </strong>
                  </div>
                </div>

                <div className="robot-focus-chain mono">
                  {focusChain
                    ? `${focusChain.feeds} → ${focusChain.ohlc} → ${focusChain.regime} → ${focusChain.action}`
                    : chainLabel}
                </div>

                {focusLegs.length > 0 && (
                  <div className="robot-focus-legs mono">
                    {focusLegs.map((leg) => (
                      <div key={leg.sender_id} className={leg.ok ? 'ok' : 'bad'}>
                        {leg.name} ·{' '}
                        {leg.ok
                          ? fmt(leg.mid, 2)
                          : leg.mid != null
                            ? `${fmt(leg.mid, 2)} FAR`
                            : 'FAIL'}{' '}
                        · {leg.latency_ms}ms
                      </div>
                    ))}
                  </div>
                )}

                {focused.error && (
                  <div className="error-state" style={{ marginTop: 6 }}>
                    {focused.error}
                  </div>
                )}

                <div className="robot-feed robot-op-ticks">
                  {focused.ticks.slice(0, 24).map((t, i) => (
                    <div key={`${t.at}-${i}`} className={`robot-feed-line phase-${t.phase.toLowerCase()}`}>
                      <span className="mono time">{new Date(t.at).toLocaleTimeString()}</span>
                      <span className="badge phase">{t.phase}</span>
                      <span className="detail">{t.detail}</span>
                    </div>
                  ))}
                  {focused.ticks.length === 0 && <div className="mono">Waiting for feed…</div>}
                </div>
              </>
            ) : (
              <div className="robot-op-focus-empty mono">
                Nav focus unit — DEPLOY vai izvēlies karti.
              </div>
            )}
          </aside>
        </div>
      </div>
      <div
        className="robot-resize-handle"
        title="Velc uz leju — palielina paneļa augstumu"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize panel height"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        onPointerCancel={onResizeUp}
      />
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
  window.location.href = `/robot?${q.toString()}`;
  return null;
}
