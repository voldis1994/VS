import { useCallback, useEffect, useRef, useState } from 'react';
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
        setSession(null);
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

  const switchRobot = (s: RobotSession) => {
    navigate(`/robot?${buildQuery(s)}`);
    setSession(s);
  };

  return (
    <div className="robot-fs-shell" ref={shellRef}>
      <div className="robot-desk robot-desk-fs">
        <div className="robot-desk-head">
          <div className="robot-brand-block">
            <Logo size={56} />
            <div>
              <div className="orbit-kicker">ONE TRADE ONLY · BEST OUTCOME EXIT</div>
              <h1 className="page-title">ROBOT DESK</h1>
              <p className="page-subtitle">
                Max 1 atvērts treids uz instrumentu. Kamēr atvērts — tikai MANAGE (bez jauniem
                entry). Entry tikai kad FLAT pēc aizvēršanas ar best outcome.
              </p>
            </div>
          </div>
          <div className="actions">
            {!isFs && (
              <button className="btn" type="button" onClick={() => void enterFs()}>
                FULLSCREEN
              </button>
            )}
            <Link className="btn" to="/">
              ← Main
            </Link>
            <button
              className="btn btn-stop"
              disabled={busy || !session?.running}
              onClick={() => void stop()}
            >
              STOP THIS ROBOT
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
            <p style={{ marginBottom: 10 }}>Nav aktīva robota šim logam.</p>
            <Link className="btn btn-primary" to="/">
              Izvēlies tirgu Main lapā → TRADING ON
            </Link>
          </div>
        )}
        {busy && !session && (
          <div className="robot-empty mono">Starting robot…</div>
        )}

        {session && (
          <>
            <div className="robot-status-grid">
              <div className={`robot-status-card ${session.running ? 'on' : 'off'}`}>
                <div className="label">STATUS</div>
                <div className="value">{session.running ? 'RUNNING' : 'STOPPED'}</div>
                <div className="mono">{session.id}</div>
              </div>
              <div className="robot-status-card">
                <div className="label">MARKET</div>
                <div className="value" style={{ fontSize: 16 }}>
                  {session.display_name}
                </div>
                <div className="mono">{session.epic}</div>
              </div>
              <div className="robot-status-card">
                <div className="label">LOT SIZE</div>
                <div className="value">{session.lot_size}</div>
              </div>
              <div className="robot-status-card">
                <div className="label">LAST MID</div>
                <div className="value pos">{fmt(session.last_mid)}</div>
              </div>
              <div className="robot-status-card">
                <div className="label">MODE</div>
                <div className="value" style={{ fontSize: 16 }}>
                  {session.mode || (session.open_side ? 'MANAGE' : 'FLAT')}
                </div>
              </div>
              <div className="robot-status-card">
                <div className="label">UPL / MFE</div>
                <div className="value" style={{ fontSize: 16 }}>
                  {fmt(session.unrealized)} / {fmt(session.mfe)}
                </div>
              </div>
            </div>

            <div className="robot-fs-grid">
              <div className="robot-panel">
                <div className="section-title">SESSION · ONE TRADE</div>
                <div className="mono" style={{ lineHeight: 1.7 }}>
                  <div>Account: {session.account_name}</div>
                  <div>Env: {session.environment.toUpperCase()}</div>
                  <div>Trading: {session.trading_enabled ? 'ON' : 'OFF'}</div>
                  <div>Side: {session.open_side || 'FLAT'}</div>
                  <div>Entry: {fmt(session.entry_price)}</div>
                  <div>DealId: {session.deal_id || '—'}</div>
                  <div>DealRef: {session.last_deal_reference || '—'}</div>
                  <div>
                    Peak ret:{' '}
                    {session.peak_retention != null
                      ? `${Math.round(session.peak_retention * 100)}%`
                      : '—'}
                  </div>
                  <div>
                    Entries/Exits: {session.orders_placed}/{session.exits_done ?? 0}
                  </div>
                  <div>
                    Reads OK/FAIL: {session.reads_ok}/{session.reads_fail}
                  </div>
                  <div>Started: {new Date(session.started_at).toLocaleTimeString()}</div>
                  <div>
                    Last quote:{' '}
                    {session.last_quote_at
                      ? new Date(session.last_quote_at).toLocaleTimeString()
                      : '—'}
                  </div>
                </div>
                {session.error && (
                  <div className="error-state" style={{ marginTop: 8 }}>
                    {session.error}
                  </div>
                )}
              </div>
              <div className="robot-panel robot-panel-log">
                <div className="section-title">LIVE ACTIVITY LOG</div>
                <div className="robot-log">
                  {session.ticks.length === 0 && (
                    <div className="mono">Waiting for first Capital read…</div>
                  )}
                  {session.ticks.map((t, i) => (
                    <div
                      key={`${t.at}-${i}`}
                      className={`robot-log-line phase-${t.phase.toLowerCase()}`}
                    >
                      <span className="mono time">
                        {new Date(t.at).toLocaleTimeString()}
                      </span>
                      <span className="badge phase">{t.phase}</span>
                      <span className="detail">{t.detail}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </>
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
