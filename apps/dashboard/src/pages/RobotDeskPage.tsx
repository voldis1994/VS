import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { apiFetch } from '../hooks/useApi';

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
  orders_placed: number;
  reads_ok: number;
  reads_fail: number;
  open_side: string | null;
  error: string | null;
};

function fmt(n: number | null | undefined, d = 5) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, { maximumFractionDigits: d });
}

export function RobotDeskPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [session, setSession] = useState<RobotSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [booted, setBooted] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const id = params.get('id') || 'active';
      const s = await apiFetch<RobotSession>(`/api/robot-desk/${id}`);
      setSession(s);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No robot session');
    }
  }, [params]);

  // Auto-start from query if provided once
  useEffect(() => {
    if (booted) return;
    const accountId = params.get('account_id');
    const epic = params.get('epic');
    const lot = params.get('lot');
    const name = params.get('name');
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
          navigate(`/robot?id=${res.session.id}`, { replace: true });
        })
        .catch((e) => setError(e instanceof Error ? e.message : 'Start failed'))
        .finally(() => setBusy(false));
      return;
    }
    setBooted(true);
    void refresh();
  }, [booted, params, navigate, refresh]);

  useEffect(() => {
    const t = setInterval(() => void refresh(), 2000);
    return () => clearInterval(t);
  }, [refresh]);

  const stop = async () => {
    if (!session) return;
    setBusy(true);
    try {
      await apiFetch(`/api/robot-desk/${session.id}/stop`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Stop failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="robot-desk">
      <div className="robot-desk-head">
        <div>
          <div className="orbit-kicker">SINGLE-MARKET ROBOT</div>
          <h1 className="page-title">ROBOT DESK</h1>
          <p className="page-subtitle">
            Robots lasa TIKAI izvēlēto Capital.com tirgu un tirgo ar TAVU lot size — live log zemāk.
          </p>
        </div>
        <div className="actions">
          <Link className="btn" to="/">
            ← Main
          </Link>
          <button className="btn btn-stop" disabled={busy || !session?.running} onClick={() => void stop()}>
            STOP ROBOT
          </button>
        </div>
      </div>

      {error && <div className="error-state" style={{ marginBottom: 10 }}>{error}</div>}
      {!session && !busy && (
        <div className="card">
          <p style={{ marginBottom: 10 }}>Nav aktīva robota.</p>
          <Link className="btn btn-primary" to="/">
            Izvēlies tirgu Main lapā → TRADING ON
          </Link>
        </div>
      )}

      {session && (
        <>
          <div className="robot-status-grid">
            <div className={`robot-status-card ${session.running ? 'on' : 'off'}`}>
              <div className="label">STATUS</div>
              <div className="value">{session.running ? 'RUNNING' : 'STOPPED'}</div>
            </div>
            <div className="robot-status-card">
              <div className="label">MARKET</div>
              <div className="value" style={{ fontSize: 16 }}>{session.display_name}</div>
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
              <div className="label">ORDERS</div>
              <div className="value">{session.orders_placed}</div>
            </div>
            <div className="robot-status-card">
              <div className="label">READS OK/FAIL</div>
              <div className="value" style={{ fontSize: 16 }}>
                {session.reads_ok}/{session.reads_fail}
              </div>
            </div>
          </div>

          <div className="grid grid-2" style={{ marginTop: 10, gap: 8 }}>
            <div className="card">
              <div className="section-title">SESSION</div>
              <div className="mono" style={{ lineHeight: 1.7 }}>
                <div>Account: {session.account_name}</div>
                <div>Env: {session.environment.toUpperCase()}</div>
                <div>Trading: {session.trading_enabled ? 'ON' : 'OFF'}</div>
                <div>Side: {session.open_side || 'FLAT'}</div>
                <div>Deal: {session.last_deal_reference || '—'}</div>
                <div>
                  Started: {new Date(session.started_at).toLocaleTimeString()}
                </div>
                <div>
                  Last quote:{' '}
                  {session.last_quote_at
                    ? new Date(session.last_quote_at).toLocaleTimeString()
                    : '—'}
                </div>
              </div>
              {session.error && (
                <div className="error-state" style={{ marginTop: 8 }}>{session.error}</div>
              )}
            </div>
            <div className="card">
              <div className="section-title">LIVE ACTIVITY LOG</div>
              <div className="robot-log">
                {session.ticks.length === 0 && <div className="mono">Waiting for first Capital read…</div>}
                {session.ticks.map((t, i) => (
                  <div key={`${t.at}-${i}`} className={`robot-log-line phase-${t.phase.toLowerCase()}`}>
                    <span className="mono time">{new Date(t.at).toLocaleTimeString()}</span>
                    <span className={`badge phase`}>{t.phase}</span>
                    <span className="detail">{t.detail}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
