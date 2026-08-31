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
] as const;

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
  zones?: string;
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
  feed_source?: 'MULTI' | 'LOCAL' | 'NONE';
  feed_contributing?: number;
  feed_sender_count?: number;
  feed_agreement?: string | null;
  feed_legs?: FeedLeg[];
  decision_chain?: DecisionChain;
  zones?: {
    ready: boolean;
    structure: string;
    high: number;
    low: number;
    bias: string;
    detail: string;
  } | null;
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

function posture(s: RobotSession): { label: string; kind: 'long' | 'short' | 'flat' | 'entry' } {
  if (!s.running && !s.open_side) return { label: 'STOPPED', kind: 'flat' };
  if (s.open_side === 'BUY') {
    const t = tradeLabel(s);
    return { label: t, kind: t.includes('SCALP') ? 'short' : 'long' };
  }
  if (s.open_side === 'SELL') {
    const t = tradeLabel(s);
    return { label: t, kind: t.includes('LONG') ? 'long' : 'short' };
  }
  if (s.running && !s.open_side) {
    const r = (s.regime || 'RANGE').toUpperCase();
    return { label: `WAIT ENTRY · ${r}`, kind: 'entry' };
  }
  return { label: 'FLAT', kind: 'flat' };
}

function tradeLabel(s: RobotSession): string {
  if (!s.open_side) return 'FLAT';
  const r = (s.regime || '').toUpperCase();
  const long =
    r === 'TREND_UP' ||
    r === 'TREND_DOWN' ||
    r === 'PULLBACK_UPTREND' ||
    r === 'PULLBACK_DOWNTREND';
  const scalp =
    r === 'BREAKOUT_UP' ||
    r === 'BREAKOUT_DOWN' ||
    r === 'FAILED_BREAKOUT_UP' ||
    r === 'FAILED_BREAKOUT_DOWN' ||
    r === 'COMPRESSION' ||
    r === 'EXPANSION' ||
    r === 'RANGE' ||
    r === 'REVERSAL_CANDIDATE';
  if (long) return `${s.open_side} LONG`;
  if (scalp) return `${s.open_side} SCALP`;
  return s.open_side;
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

  const focused = sessions.find((s) => s.id === focusId) || null;
  const runningCount = sessions.filter((s) => s.running).length;
  const regimes = board?.regimes?.length ? board.regimes : [...ALL_REGIMES];
  const activeRegimes = new Set(
    (board?.active_regimes?.length
      ? board.active_regimes
      : sessions.filter((s) => s.running).map((s) => s.regime || 'RANGE')
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
    board?.chain || 'PUBLIC INTERNET + Capital → consensus mid → 10s OHLC → REGIME → ENTRY/EXIT';
  const boardNote =
    board?.note ||
    'Public feeds: Yahoo, Aurum, Fawaz FX, Coinbase — fused with Capital for 10s OHLC';
  const tradeTypes = board?.trade_types || ['BUY LONG', 'SELL LONG', 'BUY SCALP', 'SELL SCALP'];
  const focusLegs = focused?.feed_legs || [];
  const focusChain = focused?.decision_chain;

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
    <div className="robot-fs-shell robot-board-shell" ref={shellRef}>
      <div className="robot-desk robot-desk-fs robot-board">
        <div className="robot-board-top">
          <div className="robot-arena-brand">
            <Logo size={72} wordmark />
            <div>
              <div className="robot-arena-kicker">VS SYSTEM // MULTI-CLIENT BOARD</div>
              <h1 className="robot-arena-title">ROBOT COMMAND</h1>
              <p className="robot-arena-sub">
                {chainLabel} · {tradeTypes.join(' · ')}
              </p>
            </div>
          </div>
          <div className="robot-board-stats">
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
            <div className="robot-mode-banner entry">
              <div className="label">REGIMES</div>
              <div className="value">{regimes.length}</div>
            </div>
          </div>
          <div className="actions">
            <button className="btn btn-primary" type="button" onClick={() => setShowDeploy((v) => !v)}>
              {showDeploy ? 'CLOSE DEPLOY' : '+ DEPLOY'}
            </button>
            <Link className="btn" to="/">
              ← BASE
            </Link>
          </div>
        </div>

        {error && <div className="error-state">{error}</div>}
        {busy && <div className="mono" style={{ color: 'var(--cyan)' }}>Syncing combat units…</div>}

        <div className="robot-wire-panel">
          <div className="robot-wire-head">
            <div className="robot-arena-kicker">WIRED CHAIN</div>
            <div className="robot-wire-chain mono">{chainLabel}</div>
          </div>
          <div className="robot-wire-regimes">
            {regimes.map((r) => {
              const name = r.toUpperCase();
              const live = activeRegimes.has(name);
              const focusHit = (focused?.regime || '').toUpperCase() === name;
              return (
                <span
                  key={name}
                  className={`robot-regime-chip ${live ? 'live' : ''} ${focusHit ? 'focus' : ''}`}
                  title={live ? 'Active on a running robot' : 'Catalog regime'}
                >
                  {name}
                </span>
              );
            })}
          </div>
          <div className="robot-wire-feeds">
            <div className="robot-arena-kicker">PUBLIC INTERNET FEEDS</div>
            <div className="mono robot-wire-empty" style={{ marginBottom: 6 }}>
              {boardNote}
            </div>
            <div className="robot-feed-legs">
              {publicSenders.map((s) => (
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
            </div>
            <div className="robot-arena-kicker" style={{ marginTop: 10 }}>
              CAPITAL EXECUTION PROVIDERS
            </div>
            {capitalSenders.length === 0 && (
              <div className="mono robot-wire-empty">
                Nav enabled Capital — orderiem vajag brokeri (Brokers). OHLC joprojām var nākt no public feeds.
              </div>
            )}
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
            </div>
          </div>
        </div>

        {showDeploy && (
          <div className="robot-empty robot-deploy-bar">
            <div className="section-title">DEPLOY CLIENT ROBOT</div>
            <div className="actions" style={{ marginTop: 8, flexWrap: 'wrap' }}>
              <select
                className="input"
                style={{ maxWidth: 320 }}
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
                style={{ maxWidth: 180 }}
                placeholder="Search market…"
                value={launchFilter}
                onChange={(e) => setLaunchFilter(e.target.value)}
              />
              <select
                className="input"
                style={{ maxWidth: 320 }}
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
                style={{ maxWidth: 90 }}
                value={launchLot}
                onChange={(e) => setLaunchLot(e.target.value)}
              />
              <button className="btn btn-go" type="button" disabled={busy} onClick={deploy}>
                DEPLOY
              </button>
            </div>
          </div>
        )}

        {sessions.length === 0 && !busy && (
          <div className="robot-empty">
            <div className="robot-arena-kicker">EMPTY BOARD</div>
            <p style={{ marginBottom: 12 }}>Vēl nav robotu. Spied + DEPLOY vai Trading → START ROBOT.</p>
            <button className="btn btn-primary" type="button" onClick={() => setShowDeploy(true)}>
              + DEPLOY FIRST UNIT
            </button>
          </div>
        )}

        <div className="robot-board-grid">
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
                <div className="robot-mini-regime mono">{(s.regime || 'RANGE').toUpperCase()}</div>
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
                  <strong className={(s.unrealized || 0) >= 0 ? 'pos' : 'neg'}>{fmt(s.unrealized)}</strong>
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
                      ? `${s.decision_chain.feeds} → ${s.decision_chain.zones || 'zones?'} → ${s.decision_chain.regime} → ${s.decision_chain.action}`
                      : `${s.mode} · ${s.regime || 'RANGE'}`
                    : 'STOPPED'}
                </div>
                {(s.feed_legs?.length ?? 0) > 0 && (
                  <div className="robot-mini-legs mono">
                    {s.feed_legs!.slice(0, 4).map((leg) => (
                      <span key={leg.sender_id} className={leg.ok ? 'ok' : 'bad'}>
                        {leg.name}:{leg.ok ? fmt(leg.mid, 2) : '×'}
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

        {focused && (
          <div className="robot-board-focus robot-hud-panel">
            <div className="robot-board-focus-head">
              <div className="section-title" style={{ margin: 0 }}>
                FOCUS · {(focused.client_name || focused.account_name).toUpperCase()} ·{' '}
                {focused.display_name}
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
            <div className="robot-board-focus-grid">
              <div className="mono" style={{ lineHeight: 1.7 }}>
                <div>STATUS · {focused.running ? 'ONLINE' : 'STOPPED'}</div>
                <div>ID · {focused.id}</div>
                <div>ACCOUNT · {focused.account_name}</div>
                <div>POSTURE · {posture(focused).label}</div>
                <div className="robot-focus-chain">
                  CHAIN ·{' '}
                  {focusChain
                    ? `${focusChain.feeds} → ${focusChain.ohlc} → ${focusChain.zones || 'zones?'} → ${focusChain.regime} → ${focusChain.action}`
                    : chainLabel}
                </div>
                <div>
                  10s OHLC · O {fmt(focused.ohlc_10s?.last_o, 2)} H {fmt(focused.ohlc_10s?.last_h, 2)} L{' '}
                  {fmt(focused.ohlc_10s?.last_l, 2)} C {fmt(focused.ohlc_10s?.last_c, 2)} ·{' '}
                  {focused.ohlc_10s?.market || 'SEEDING'}
                </div>
                <div>MODE · {focused.running ? focused.mode : 'STOPPED'}</div>
                <div>REGIME · {(focused.regime || 'RANGE').toUpperCase()}</div>
                <div>
                  FEEDS · {focused.feed_contributing ?? 0}/{focused.feed_sender_count ?? 0}{' '}
                  {focused.feed_agreement || ''} · {focused.feed_source || '—'}
                </div>
                {focusLegs.length > 0 && (
                  <div className="robot-focus-legs">
                    {focusLegs.map((leg) => (
                      <div key={leg.sender_id} className={leg.ok ? 'ok' : 'bad'}>
                        {leg.name} · {leg.ok ? fmt(leg.mid, 2) : 'FAIL'} · {leg.latency_ms}ms
                        {leg.detail ? ` · ${leg.detail}` : ''}
                      </div>
                    ))}
                  </div>
                )}
                <div>ENTRY · {fmt(focused.entry_price)}</div>
                <div>SAFETY SL · {fmt(focused.safety_sl)}</div>
                <div>DEAL · {focused.deal_id || '—'}</div>
                <div>
                  SCORE · IN {focused.orders_placed} / OUT {focused.exits_done ?? 0}
                </div>
                <div>
                  READS · {focused.reads_ok}/{focused.reads_fail}
                </div>
                {focused.error && <div className="error-state" style={{ marginTop: 8 }}>{focused.error}</div>}
              </div>
              <div className="robot-feed">
                {focused.ticks.slice(0, 40).map((t, i) => (
                  <div key={`${t.at}-${i}`} className={`robot-feed-line phase-${t.phase.toLowerCase()}`}>
                    <span className="mono time">{new Date(t.at).toLocaleTimeString()}</span>
                    <span className="badge phase">{t.phase}</span>
                    <span className="detail">{t.detail}</span>
                  </div>
                ))}
                {focused.ticks.length === 0 && <div className="mono">Waiting for feed…</div>}
              </div>
            </div>
          </div>
        )}
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
