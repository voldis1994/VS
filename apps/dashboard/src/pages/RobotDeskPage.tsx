import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { apiFetch } from '../hooks/useApi';
import { Logo } from '../components/Logo';
import {
  isEurUsdMarket,
  lotForMarket,
  marketKey,
  pickSwitchTarget,
} from '../lib/preferMarket';

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
  playbook?: string | null;
  entry_setup?: string | null;
  market_setup?: {
    kind: string;
    side: string | null;
    status: string;
    playbook: string | null;
    reason: string;
    swing_high?: number;
    swing_low?: number;
    watch_buy?: string | null;
    watch_sell?: string | null;
  } | null;
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

function lookingFor(s: RobotSession): { text: string; kind: 'buy' | 'sell' | 'flat' | 'open' } {
  if (s.open_side === 'BUY') return { text: 'IN TRADE · BUY', kind: 'open' };
  if (s.open_side === 'SELL') return { text: 'IN TRADE · SELL', kind: 'open' };
  if (!s.running) return { text: 'STOPPED', kind: 'flat' };
  const side = (s.market_setup?.side || '').toUpperCase();
  const status = (s.market_setup?.status || '').toUpperCase();
  const kind = (s.market_setup?.kind || s.entry_setup || 'NONE').toUpperCase();
  if (kind === 'NONE' || status === 'NONE' || !side) return { text: 'NONE · gaida setup', kind: 'flat' };
  if (status === 'FORMING') return { text: `FORMING · ${side}`, kind: side === 'BUY' ? 'buy' : 'sell' };
  return { text: `LOOKING FOR ${side}`, kind: side === 'BUY' ? 'buy' : 'sell' };
}

function setupWhy(s: RobotSession): string {
  return s.market_setup?.reason || s.decision_chain?.action || lastLog(s);
}

function swingLine(s: RobotSession): string {
  const hi = s.market_setup?.swing_high ?? s.zones?.high;
  const lo = s.market_setup?.swing_low ?? s.zones?.low;
  if (hi == null || lo == null || !(hi > 0)) return 'swing seeding…';
  return `H ${fmt(hi, 2)}  ·  L ${fmt(lo, 2)}`;
}

function ohlcLine(s: RobotSession): string {
  const o = s.ohlc_10s;
  if (!o || o.last_c == null) return '10s SEEDING';
  return `10s ${fmt(o.last_o, 2)}→${fmt(o.last_c, 2)} · ${o.market}`;
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

  const focused = sessions.find((s) => s.id === focusId) || sessions.find((s) => s.running) || null;
  const liveSessions = sessions.filter((s) => s.running);
  const runningCount = liveSessions.length;

  useEffect(() => {
    if (focused?.account_id && focused.account_id !== launchAccountId) {
      setLaunchAccountId(focused.account_id);
    }
  }, [focused?.account_id, launchAccountId]);

  useEffect(() => {
    if (!launchAccountId) return;
    void apiFetch<typeof launchMarkets>(`/api/trading/accounts/${launchAccountId}/instruments`)
      .then((rows) => {
        const list = rows || [];
        setLaunchMarkets(list);
        const pick = pickSwitchTarget(list, focused?.epic);
        if (!pick) return;
        setLaunchEpic(marketKey(pick));
        setLaunchLot(String(lotForMarket(pick)));
      })
      .catch(() => setLaunchMarkets([]));
  }, [launchAccountId, focused?.epic]);

  const filteredLaunch = useMemo(() => {
    const q = launchFilter.trim().toLowerCase();
    const rows = !q
      ? [...launchMarkets]
      : launchMarkets.filter(
          (m) =>
            m.display_name.toLowerCase().includes(q) ||
            (m.epic || m.symbol).toLowerCase().includes(q),
        );
    rows.sort((a, b) => Number(isEurUsdMarket(b)) - Number(isEurUsdMarket(a)));
    return rows.slice(0, 200);
  }, [launchMarkets, launchFilter]);

  const eurUsdMarket = useMemo(() => launchMarkets.find(isEurUsdMarket) || null, [launchMarkets]);

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

  const switchSessionToMarket = async (
    s: RobotSession,
    epic: string,
    displayName?: string,
    lotSize?: number,
  ) => {
    const m = launchMarkets.find((x) => marketKey(x) === epic);
    const lot = Number(lotSize ?? launchLot ?? lotForMarket(m));
    if (!epic) {
      setError('Izvēlies tirgu');
      return;
    }
    if (!Number.isFinite(lot) || lot <= 0) {
      setError('Lot > 0');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ session: RobotSession }>('/api/robot-desk/start', {
        method: 'POST',
        body: JSON.stringify({
          account_id: s.account_id,
          epic,
          display_name: displayName || m?.display_name || epic,
          lot_size: lot,
          trading_enabled: true,
        }),
      });
      setFocusId(res.session.id);
      setShowDeploy(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Switch market failed');
    } finally {
      setBusy(false);
    }
  };

  const switchFocusedMarket = async () => {
    if (!focused || !launchEpic) return;
    const m = launchMarkets.find((x) => marketKey(x) === launchEpic);
    await switchSessionToMarket(focused, launchEpic, m?.display_name, Number(launchLot));
  };

  const switchToEurUsd = async (s: RobotSession) => {
    const m = eurUsdMarket || pickSwitchTarget(launchMarkets, s.epic);
    if (!m || !isEurUsdMarket(m)) {
      setError('EUR/USD nav katalogā — pull Capital markets, tad SWITCH');
      setShowDeploy(true);
      setLaunchFilter('eur');
      return;
    }
    await switchSessionToMarket(s, marketKey(m), m.display_name, lotForMarket(m));
  };

  const sessionIsEurUsd = (s: RobotSession) =>
    isEurUsdMarket({ epic: s.epic, symbol: s.epic, display_name: s.display_name });

  return (
    <div className="robot-fs-shell robot-board-shell" ref={shellRef}>
      <div className="robot-desk robot-desk-fs robot-board robot-board-v2 robot-board-fill">
        <header className="robot-board-top">
          <div className="robot-arena-brand">
            <Logo size={48} wordmark />
            <div>
              <div className="robot-arena-kicker">VS · OWN BRAIN PER CLIENT</div>
              <h1 className="robot-arena-title">ROBOT DESK</h1>
              <p className="robot-arena-sub">
                {board?.note || 'structure → setup → entry → best outcome'}
              </p>
            </div>
          </div>
          <div className="robot-board-stats">
            <div className="robot-mode-banner entry">
              <div className="label">CLIENTS</div>
              <div className="value">{liveSessions.length}</div>
            </div>
            <div className={`robot-mode-banner ${runningCount ? 'manage' : 'flat'}`}>
              <div className="label">LIVE</div>
              <div className="value">{runningCount}</div>
            </div>
            <div className="robot-mode-banner flat">
              <div className="label">FEEDS</div>
              <div className="value">
                {board?.feed_contributing ?? 0}/
                {board?.feed_sender_count ?? (senders.length || '—')}
              </div>
            </div>
          </div>
          <div className="actions">
            {focused && !sessionIsEurUsd(focused) && (
              <button
                className="btn btn-go"
                type="button"
                disabled={busy}
                onClick={() => void switchToEurUsd(focused)}
              >
                {(focused.client_name || focused.account_name).toUpperCase()} → EUR/USD
              </button>
            )}
            <button className="btn btn-primary" type="button" onClick={() => setShowDeploy((v) => !v)}>
              {showDeploy ? 'CLOSE' : '+ DEPLOY'}
            </button>
            <Link className="btn" to="/">
              ← BASE
            </Link>
          </div>
        </header>

        {error && <div className="error-state">{error}</div>}
        {busy && <div className="mono" style={{ color: 'var(--cyan)' }}>Sync…</div>}

        {showDeploy && (
          <div className="robot-empty robot-deploy-bar">
            <div className="section-title">
              {focused
                ? `SWITCH ${(focused.client_name || focused.account_name).toUpperCase()} — default EUR/USD (stops ${focused.display_name})`
                : 'DEPLOY CLIENT ROBOT'}
            </div>
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
              <button className="btn btn-go" type="button" disabled={busy} onClick={focused ? switchFocusedMarket : deploy}>
                {focused ? 'SWITCH' : 'DEPLOY'}
              </button>
            </div>
          </div>
        )}

        <section className="robot-board-body">
          {liveSessions.length === 0 && !busy && (
            <div className="robot-empty">
              <div className="robot-arena-kicker">EMPTY BOARD</div>
              <p style={{ marginBottom: 12 }}>Vēl nav robotu. Spied + DEPLOY.</p>
              <button className="btn btn-primary" type="button" onClick={() => setShowDeploy(true)}>
                + DEPLOY FIRST UNIT
              </button>
            </div>
          )}

          {liveSessions.length > 0 && (
            <div className="robot-board-grid">
              {liveSessions.map((s) => {
                const look = lookingFor(s);
                const active = focusId === s.id;
                const setupKind = (s.market_setup?.kind || s.entry_setup || 'NONE').toUpperCase();
                const setupStatus = (s.market_setup?.status || '').toUpperCase();
                return (
                  <div
                    key={s.id}
                    role="button"
                    tabIndex={0}
                    className={`robot-mini robot-mini-v2 ${look.kind} ${s.running ? 'on' : 'off'} ${active ? 'active' : ''}`}
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
                    <div className="robot-mini-market">
                      {s.display_name}{' '}
                      <span className="mono" style={{ opacity: 0.7 }}>
                        {fmt(s.last_mid, 2)}
                      </span>
                    </div>
                    <div className={`robot-look ${look.kind}`}>{look.text}</div>
                    <div className="robot-mini-regime mono">
                      {setupKind}
                      {setupStatus ? ` · ${setupStatus}` : ''}
                      {s.market_setup?.playbook ? ` · ${s.market_setup.playbook}` : ''}
                    </div>
                    <div className="robot-mini-row">
                      <span>WATCH</span>
                      <strong className="robot-watch-both">
                        {s.market_setup?.watch_buy || 'BUY—'} · {s.market_setup?.watch_sell || 'SELL—'}
                      </strong>
                    </div>
                    <div className="robot-mini-row">
                      <span>SWING</span>
                      <strong>{swingLine(s)}</strong>
                    </div>
                    <div className="robot-mini-row">
                      <span>10s</span>
                      <strong className={s.ohlc_10s?.market === 'MOVING' ? 'pos' : ''}>
                        {ohlcLine(s)}
                      </strong>
                    </div>
                    <div className="robot-mini-row">
                      <span>UPL</span>
                      <strong className={(s.unrealized || 0) >= 0 ? 'pos' : 'neg'}>{fmt(s.unrealized)}</strong>
                    </div>
                    <div className="robot-mini-why mono">{setupWhy(s)}</div>
                    <div className="robot-mini-actions">
                      <span className="mono">{s.environment.toUpperCase()}</span>
                      <div className="robot-ctrl" onClick={(e) => e.stopPropagation()}>
                        {!sessionIsEurUsd(s) && (
                          <button
                            type="button"
                            className="btn btn-go"
                            disabled={busy}
                            onClick={() => void switchToEurUsd(s)}
                          >
                            → EUR/USD
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={busy}
                          onClick={() => {
                            setFocusId(s.id);
                            setShowDeploy(true);
                            setLaunchFilter('eur');
                            const pick = pickSwitchTarget(launchMarkets, s.epic);
                            if (pick) {
                              setLaunchEpic(marketKey(pick));
                              setLaunchLot(String(lotForMarket(pick)));
                            }
                          }}
                        >
                          SWITCH
                        </button>
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
          )}

          {focused && (
            <div className="robot-story">
              <div className="robot-story-head">
                <div>
                  <div className="robot-arena-kicker">FOCUS CLIENT</div>
                  <div className="robot-story-title">
                    {(focused.client_name || focused.account_name).toUpperCase()} · {focused.display_name}
                  </div>
                </div>
                <div className="robot-ctrl robot-ctrl-lg">
                  {!sessionIsEurUsd(focused) && (
                    <button
                      type="button"
                      className="btn btn-go"
                      disabled={busy}
                      onClick={() => void switchToEurUsd(focused)}
                    >
                      → EUR/USD
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={() => {
                      setShowDeploy(true);
                      setLaunchFilter('eur');
                    }}
                  >
                    SWITCH
                  </button>
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

              <div className="robot-story-hero">
                <div className={`robot-story-look ${lookingFor(focused).kind}`}>
                  <div className="label">TAGAD</div>
                  <div className="value">{lookingFor(focused).text}</div>
                </div>
                <div className="robot-story-block">
                  <div className="label">SETUP</div>
                  <div className="value">
                    {(focused.market_setup?.kind || 'NONE').toUpperCase()}
                    {focused.market_setup?.status ? ` · ${focused.market_setup.status}` : ''}
                    {focused.market_setup?.side ? ` · ${focused.market_setup.side}` : ''}
                  </div>
                </div>
                <div className="robot-story-block">
                  <div className="label">MID / LOT</div>
                  <div className="value">
                    {fmt(focused.last_mid, 2)} · {focused.lot_size}
                  </div>
                </div>
                <div className="robot-story-block">
                  <div className="label">UPL</div>
                  <div className={`value ${(focused.unrealized || 0) >= 0 ? 'pos' : 'neg'}`}>
                    {fmt(focused.unrealized)}
                  </div>
                </div>
              </div>

              <div className="robot-story-grid">
                <div className="robot-story-panel">
                  <div className="robot-arena-kicker">KĀPĒC</div>
                  <p className="robot-story-reason">{setupWhy(focused)}</p>
                  <div className="robot-story-meta mono">
                    <div>
                      WATCH BUY · {focused.market_setup?.watch_buy || '—'}
                    </div>
                    <div>
                      WATCH SELL · {focused.market_setup?.watch_sell || '—'}
                    </div>
                    <div>SWING · {swingLine(focused)}</div>
                    <div>{ohlcLine(focused)}</div>
                    <div>
                      PLAYBOOK · {(focused.playbook || focused.market_setup?.playbook || '—').toString()}
                    </div>
                    <div>
                      ENTRY · {fmt(focused.entry_price)} · SL {fmt(focused.safety_sl)}
                    </div>
                    <div>
                      SCORE · IN {focused.orders_placed} / OUT {focused.exits_done ?? 0} · READS{' '}
                      {focused.reads_ok}/{focused.reads_fail}
                    </div>
                    <div>ID · {focused.id}</div>
                    {focused.error && <div className="error-state">{focused.error}</div>}
                  </div>
                </div>
                <div className="robot-story-panel robot-story-log">
                  <div className="robot-arena-kicker">LIVE LOG</div>
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
            </div>
          )}
        </section>
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
