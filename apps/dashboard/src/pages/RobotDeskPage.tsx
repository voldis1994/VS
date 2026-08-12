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

type RobotSession = {
  id: string;
  account_id: number;
  account_name: string;
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
  orders_placed: number;
  exits_done: number;
  reads_ok: number;
  reads_fail: number;
  open_side: string | null;
  error: string | null;
};

function fmt(n: number | null | undefined, d = 5) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, { maximumFractionDigits: d });
}

function stableRobotWindowName(accountId: string, epic: string) {
  const safe = epic.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60);
  return `mr_robot_${accountId}_${safe}`;
}

export function RobotDeskPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [session, setSession] = useState<RobotSession | null>(null);
  const [siblings, setSiblings] = useState<RobotSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [booted, setBooted] = useState(false);
  const [isFs, setIsFs] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);
  const [launchAccounts, setLaunchAccounts] = useState<
    { account_id: number; client_name: string; broker_name: string; environment: string; capital_market_count?: number }[]
  >([]);
  const [launchAccountId, setLaunchAccountId] = useState<number | null>(null);
  const [launchMarkets, setLaunchMarkets] = useState<
    { instrument_id: number; epic?: string; symbol: string; display_name: string; lot_size: number; min_lot: number }[]
  >([]);
  const [launchFilter, setLaunchFilter] = useState('');
  const [launchEpic, setLaunchEpic] = useState('');
  const [launchLot, setLaunchLot] = useState('0.1');

  const accountId = params.get('account_id');
  const epic = params.get('epic');
  const lot = params.get('lot');
  const name = params.get('name');
  const idParam = params.get('id');

  const buildQuery = useCallback(
    (s: RobotSession) => {
      const q = new URLSearchParams();
      q.set('id', s.id);
      q.set('account_id', String(s.account_id));
      q.set('epic', s.epic);
      q.set('lot', String(s.lot_size));
      q.set('name', s.display_name);
      return q.toString();
    },
    [],
  );

  const refresh = useCallback(async () => {
    try {
      const q = new URLSearchParams();
      if (idParam) q.set('id', idParam);
      if (accountId) q.set('account_id', accountId);
      if (epic) q.set('epic', epic);

      const list = await apiFetch<{
        active: RobotSession | null;
        sessions: RobotSession[];
      }>(`/api/robot-desk?${q.toString()}`);

      setSiblings(list.sessions || []);

      let s = list.active;
      if (!s && idParam) {
        try {
          const pathQ = new URLSearchParams();
          if (accountId) pathQ.set('account_id', accountId);
          if (epic) pathQ.set('epic', epic);
          s = await apiFetch<RobotSession>(
            `/api/robot-desk/${encodeURIComponent(idParam)}?${pathQ.toString()}`,
          );
        } catch {
          s = null;
        }
      }
      if (!s && accountId && epic) {
        try {
          const pathQ = new URLSearchParams({
            account_id: accountId,
            epic,
          });
          s = await apiFetch<RobotSession>(`/api/robot-desk/resolve?${pathQ.toString()}`);
        } catch {
          s = null;
        }
      }

      if (s) {
        setSession(s);
        setError(null);
        // Keep URL keyed by account+epic+id so refresh never loses the robot
        const next = buildQuery(s);
        const cur = params.toString();
        if (next !== cur) {
          navigate(`/robot?${next}`, { replace: true });
        }
      } else if (!busy) {
        // Bare /robot — attach to first running robot if any
        const running = (list.sessions || []).find((x) => x.running);
        if (running && !accountId && !epic && !idParam) {
          setSession(running);
          setError(null);
          navigate(`/robot?${buildQuery(running)}`, { replace: true });
        } else {
          setSession(null);
        }
      }
    } catch (e) {
      // Soft — never flash opaque id errors while starting
      if (!busy) setError(e instanceof Error ? e.message : 'Robot sync failed');
    }
  }, [accountId, epic, idParam, params, navigate, buildQuery, busy]);

  // Auto fullscreen — robot is always full viewport / client window
  useEffect(() => {
    const onFs = () => setIsFs(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFs);
    onFs();
    const el = shellRef.current;
    const tryFs = async () => {
      try {
        if (el && !document.fullscreenElement) {
          await el.requestFullscreen();
        }
      } catch {
        /* browser may block until gesture — UI still 100dvh */
      }
    };
    void tryFs();
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  // Auto-start from query once
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
          setSession(res.session);
          setError(null);
          navigate(`/robot?${buildQuery(res.session)}`, { replace: true });
        })
        .catch((e) => setError(e instanceof Error ? e.message : 'Start failed'))
        .finally(() => setBusy(false));
      return;
    }
    setBooted(true);
    void refresh();
  }, [booted, accountId, epic, lot, name, navigate, buildQuery, refresh]);

  useEffect(() => {
    const t = setInterval(() => void refresh(), 2000);
    return () => clearInterval(t);
  }, [refresh]);

  const enterFs = async () => {
    try {
      if (shellRef.current && !document.fullscreenElement) {
        await shellRef.current.requestFullscreen();
      }
    } catch {
      /* ignore */
    }
  };

  const stop = async () => {
    if (!session) return;
    setBusy(true);
    try {
      await apiFetch(`/api/robot-desk/${encodeURIComponent(session.id)}/stop`, {
        method: 'POST',
        body: JSON.stringify({
          account_id: session.account_id,
          epic: session.epic,
        }),
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Stop failed');
    } finally {
      setBusy(false);
    }
  };

  // Load launcher catalogs when empty
  useEffect(() => {
    if (session || busy) return;
    void apiFetch<typeof launchAccounts>('/api/trading/accounts')
      .then((rows) => {
        setLaunchAccounts(rows || []);
        if (!launchAccountId && rows?.[0]) setLaunchAccountId(rows[0].account_id);
      })
      .catch(() => setLaunchAccounts([]));
  }, [session, busy, launchAccountId]);

  useEffect(() => {
    if (!launchAccountId || session) return;
    void apiFetch<typeof launchMarkets>(`/api/trading/accounts/${launchAccountId}/instruments`)
      .then((rows) => {
        setLaunchMarkets(rows || []);
        if (rows?.[0]) {
          setLaunchEpic(rows[0].epic || rows[0].symbol);
          setLaunchLot(String(rows[0].lot_size || rows[0].min_lot || 0.1));
        }
      })
      .catch(() => setLaunchMarkets([]));
  }, [launchAccountId, session]);

  const filteredLaunch = useMemo(() => {
    const q = launchFilter.trim().toLowerCase();
    const rows = launchMarkets;
    if (!q) return rows.slice(0, 200);
    return rows
      .filter(
        (m) =>
          m.display_name.toLowerCase().includes(q) ||
          (m.epic || m.symbol).toLowerCase().includes(q),
      )
      .slice(0, 200);
  }, [launchMarkets, launchFilter]);

  const startFromLauncher = () => {
    if (!launchAccountId || !launchEpic) {
      setError('Izvēlies account + Capital.com tirgu');
      return;
    }
    const lotN = Number(launchLot);
    if (!Number.isFinite(lotN) || lotN <= 0) {
      setError('Lot size must be > 0');
      return;
    }
    const m = launchMarkets.find((x) => (x.epic || x.symbol) === launchEpic);
    const display = m?.display_name || launchEpic;
    setBusy(true);
    setError(null);
    void apiFetch<{ session: RobotSession }>('/api/robot-desk/start', {
      method: 'POST',
      body: JSON.stringify({
        account_id: launchAccountId,
        epic: launchEpic,
        display_name: display,
        lot_size: lotN,
        trading_enabled: true,
      }),
    })
      .then((res) => {
        setSession(res.session);
        navigate(`/robot?${buildQuery(res.session)}`, { replace: true });
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Start failed'))
      .finally(() => setBusy(false));
  };

  const switchRobot = (s: RobotSession) => {
    navigate(`/robot?${buildQuery(s)}`);
    setSession(s);
  };

  const mode =
    session?.mode ||
    (session?.open_side ? 'MANAGE' : session ? 'FLAT' : 'STANDBY');
  const mfePct = Math.min(100, Math.abs(session?.mfe || 0) * 800);
  const uplPct = Math.min(
    100,
    Math.max(0, ((session?.unrealized || 0) / Math.max(Math.abs(session?.mfe || 0.0001), 0.0001)) * 100),
  );
  const retPct =
    session?.peak_retention != null ? Math.round(session.peak_retention * 100) : 0;

  return (
    <div className="robot-fs-shell" ref={shellRef}>
      <div className="robot-desk robot-desk-fs">
        <div className="robot-arena-top">
          <div className="robot-arena-brand">
            <Logo size={96} />
            <div>
              <div className="robot-arena-kicker">VS SYSTEM // COMBAT UNIT</div>
              <h1 className="robot-arena-title">ROBOT ARENA</h1>
              <p className="robot-arena-sub">
                ONE TRADE ONLY · best-outcome exit · live Capital feed locked to your instrument
              </p>
            </div>
          </div>

          <div
            className={`robot-mode-banner ${String(mode).toLowerCase()}`}
          >
            <div className="label">ACTIVE MODE</div>
            <div className="value">{mode}</div>
          </div>

          <div className="actions">
            {!isFs && (
              <button className="btn" type="button" onClick={() => void enterFs()}>
                FULLSCREEN
              </button>
            )}
            <Link className="btn" to="/">
              ← BASE
            </Link>
            <button
              className="btn btn-stop"
              disabled={busy || !session?.running}
              onClick={() => void stop()}
            >
              ABORT ROBOT
            </button>
          </div>
        </div>

        {siblings.length > 1 && (
          <div className="robot-sibling-bar">
            {siblings.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`robot-sibling ${session?.id === s.id ? 'active' : ''} ${
                  s.running ? 'on' : 'off'
                }`}
                onClick={() => switchRobot(s)}
              >
                <span className="mono">{s.account_name}</span>
                <span>{s.display_name}</span>
                <span className="mono">{s.running ? 'ON' : 'OFF'}</span>
              </button>
            ))}
          </div>
        )}

        {error && (
          <div className="error-state" style={{ marginBottom: 10 }}>
            {error}
          </div>
        )}

        {!session && !busy && (
          <div className="robot-empty">
            <div className="robot-arena-kicker">DEPLOY UNIT</div>
            <h2 className="robot-arena-title" style={{ fontSize: 24, marginBottom: 10 }}>
              NO ACTIVE COMBAT BOT
            </h2>
            <p style={{ marginBottom: 14, color: 'var(--text-secondary)' }}>
              Lock a Capital.com market and deploy. One trade max — manage until best exit.
            </p>

            {siblings.some((s) => s.running) && (
              <div style={{ marginBottom: 14 }}>
                <div className="section-title">LIVE UNITS</div>
                <div className="robot-sibling-bar" style={{ marginTop: 8 }}>
                  {siblings
                    .filter((s) => s.running)
                    .map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        className="robot-sibling on"
                        onClick={() => switchRobot(s)}
                      >
                        <span className="mono">{s.account_name}</span>
                        <span>{s.display_name}</span>
                        <span className="mono">OPEN</span>
                      </button>
                    ))}
                </div>
              </div>
            )}

            <div className="section-title">DEPLOY CONTROLS</div>
            <div className="actions" style={{ marginTop: 8, marginBottom: 8, flexWrap: 'wrap' }}>
              <select
                className="input"
                style={{ maxWidth: 360 }}
                value={launchAccountId ?? ''}
                onChange={(e) => setLaunchAccountId(Number(e.target.value))}
              >
                {launchAccounts.length === 0 && <option value="">No accounts</option>}
                {launchAccounts.map((a) => (
                  <option key={a.account_id} value={a.account_id}>
                    #{a.account_id} {a.client_name} / {a.broker_name} ({a.environment})
                    {a.capital_market_count != null ? ` · ${a.capital_market_count}` : ''}
                  </option>
                ))}
              </select>
              <input
                className="input"
                style={{ maxWidth: 200 }}
                placeholder="Search market…"
                value={launchFilter}
                onChange={(e) => setLaunchFilter(e.target.value)}
              />
              <select
                className="input"
                style={{ maxWidth: 360 }}
                value={launchEpic}
                onChange={(e) => {
                  setLaunchEpic(e.target.value);
                  const m = launchMarkets.find((x) => (x.epic || x.symbol) === e.target.value);
                  if (m) setLaunchLot(String(m.lot_size || m.min_lot || 0.1));
                }}
              >
                {filteredLaunch.length === 0 && (
                  <option value="">Pull markets in Trading first</option>
                )}
                {filteredLaunch.map((m) => (
                  <option key={m.instrument_id} value={m.epic || m.symbol}>
                    {m.display_name} · {m.epic || m.symbol}
                  </option>
                ))}
              </select>
              <input
                className="input"
                style={{ maxWidth: 100 }}
                value={launchLot}
                onChange={(e) => setLaunchLot(e.target.value)}
              />
              <button
                className="btn btn-primary"
                type="button"
                disabled={!launchAccountId || !launchEpic}
                onClick={startFromLauncher}
              >
                DEPLOY ROBOT
              </button>
            </div>
          </div>
        )}

        {busy && !session && (
          <div className="robot-empty mono">Booting VS combat unit…</div>
        )}

        {session && (
          <div className="robot-arena-stage">
            <div className="robot-hud-panel">
              <div className="section-title">TARGET LOCK</div>
              <div className="robot-radar">
                <div className="robot-radar-sweep" />
                <div className="robot-radar-core">
                  <div className="mid">{fmt(session.last_mid)}</div>
                  <div className="meta">{session.display_name}</div>
                  <div className="meta">{session.open_side || 'FLAT'} · LOT {session.lot_size}</div>
                </div>
              </div>
              <div className="robot-power">
                <div className="robot-power-row">
                  <span>MFE</span>
                  <div className="robot-power-bar">
                    <div className="robot-power-fill" style={{ width: `${mfePct}%` }} />
                  </div>
                  <span>{fmt(session.mfe)}</span>
                </div>
                <div className="robot-power-row">
                  <span>UPL</span>
                  <div className="robot-power-bar">
                    <div
                      className={`robot-power-fill${(session.unrealized || 0) < 0 ? ' bad' : ''}`}
                      style={{ width: `${Math.max(8, uplPct)}%` }}
                    />
                  </div>
                  <span>{fmt(session.unrealized)}</span>
                </div>
                <div className="robot-power-row">
                  <span>PEAK</span>
                  <div className="robot-power-bar">
                    <div className="robot-power-fill" style={{ width: `${retPct}%` }} />
                  </div>
                  <span>{retPct}%</span>
                </div>
              </div>
            </div>

            <div className="robot-hud-panel">
              <div className="section-title">UNIT STATUS</div>
              <div className="mono" style={{ lineHeight: 1.85, fontSize: 13 }}>
                <div>STATUS · {session.running ? 'ONLINE' : 'OFFLINE'}</div>
                <div>ID · {session.id}</div>
                <div>ACCOUNT · {session.account_name}</div>
                <div>ENV · {session.environment.toUpperCase()}</div>
                <div>SIDE · {session.open_side || 'FLAT'}</div>
                <div>ENTRY · {fmt(session.entry_price)}</div>
                <div>DEAL · {session.deal_id || '—'}</div>
                <div>REF · {session.last_deal_reference || '—'}</div>
                <div>
                  SCORE · IN {session.orders_placed} / OUT {session.exits_done ?? 0}
                </div>
                <div>
                  READS · {session.reads_ok}/{session.reads_fail}
                </div>
                <div>BOOT · {new Date(session.started_at).toLocaleTimeString()}</div>
              </div>
              {session.error && (
                <div className="error-state" style={{ marginTop: 10 }}>
                  {session.error}
                </div>
              )}
            </div>

            <div className="robot-hud-panel">
              <div className="section-title">COMBAT FEED</div>
              <div className="robot-feed">
                {session.ticks.length === 0 && (
                  <div className="mono">Awaiting first Capital ping…</div>
                )}
                {session.ticks.map((t, i) => (
                  <div
                    key={`${t.at}-${i}`}
                    className={`robot-feed-line phase-${t.phase.toLowerCase()}`}
                  >
                    <span className="mono time">{new Date(t.at).toLocaleTimeString()}</span>
                    <span className="badge phase">{t.phase}</span>
                    <span className="detail">{t.detail}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Open / reuse a named window per account+epic (for multi-client desks) */
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
  const winName = stableRobotWindowName(String(opts.accountId), opts.epic);
  const features = 'noopener,noreferrer';
  const w = window.open(`/robot?${q.toString()}`, winName, features);
  if (w) {
    try {
      w.focus();
    } catch {
      /* ignore */
    }
  }
  return w;
}
