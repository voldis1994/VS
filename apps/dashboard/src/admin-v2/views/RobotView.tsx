import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { MarketSearchPicker } from '../components/MarketSearchPicker';
import { apiFetch } from '../../hooks/useApi';
import { fmtNum } from '../lib/format';

type RobotTick = { at: string; phase: string; detail: string };

type RobotSession = {
  id: string;
  account_id: number;
  account_name: string;
  client_name?: string;
  display_name: string;
  lot_size: number;
  running: boolean;
  last_mid: number | null;
  unrealized: number | null;
  regime?: string;
  open_side: string | null;
  mode: string;
  safety_sl: number | null;
  feed_contributing?: number;
  feed_sender_count?: number;
  ohlc_10s?: { market: string };
  ticks: RobotTick[];
  epic: string;
  error: string | null;
};

type BoardMeta = {
  regimes: string[];
  active_regimes: string[];
  feed_sender_count: number;
  feed_contributing: number;
};

const ALL_REGIMES = [
  'COMPRESSION', 'BREAKOUT_UP', 'BREAKOUT_DOWN',
] as const;

function posture(s: RobotSession) {
  if (!s.running && !s.open_side) return { label: 'STOPPED', kind: 'flat' as const };
  if (s.open_side) return { label: s.open_side, kind: 'long' as const };
  if (s.running) {
    if (s.ohlc_10s?.market === 'SEEDING') return { label: 'SEEDING · OHLC', kind: 'entry' as const };
    const r = String(s.regime || 'COMPRESSION').toUpperCase();
    if (r === 'UNKNOWN') return { label: 'WAIT · COMPRESSION', kind: 'entry' as const };
    return { label: `WAIT · ${r}`, kind: 'entry' as const };
  }
  return { label: 'FLAT', kind: 'flat' as const };
}

function lastLog(s: RobotSession) {
  const t = s.ticks?.[0];
  return t ? t.detail : 'Booting…';
}

export function RobotView() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<RobotSession[]>([]);
  const [board, setBoard] = useState<BoardMeta | null>(null);
  const [focusId, setFocusId] = useState<string | null>(params.get('id'));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showDeploy, setShowDeploy] = useState(false);
  const [booted, setBooted] = useState(false);

  const accountId = params.get('account_id');
  const epic = params.get('epic');
  const lot = params.get('lot');
  const name = params.get('name');

  const [launchAccounts, setLaunchAccounts] = useState<
    { account_id: number; client_name: string; environment: string }[]
  >([]);
  const [launchAccountId, setLaunchAccountId] = useState<number | null>(null);
  const [launchMarkets, setLaunchMarkets] = useState<
    { instrument_id: number; epic?: string; symbol: string; display_name: string; lot_size: number; min_lot: number }[]
  >([]);
  const [launchEpic, setLaunchEpic] = useState('');
  const [launchLot, setLaunchLot] = useState('0.1');

  const refresh = useCallback(async () => {
    try {
      const list = await apiFetch<{ sessions: RobotSession[]; board?: BoardMeta }>('/api/robot-desk');
      const rows = list.sessions || [];
      setSessions(rows);
      setBoard(list.board || null);
      setError(null);
      setFocusId((prev) => {
        if (prev && rows.some((r) => r.id === prev)) return prev;
        return rows.find((r) => r.running)?.id || rows[0]?.id || null;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sync failed');
    }
  }, []);

  useEffect(() => {
    if (booted) return;
    if (accountId && epic && lot) {
      setBooted(true);
      setBusy(true);
      void apiFetch('/api/robot-desk/start', {
        method: 'POST',
        body: JSON.stringify({
          account_id: Number(accountId),
          epic,
          display_name: name || undefined,
          lot_size: Number(lot),
          trading_enabled: true,
        }),
      })
        .then((res: { session: RobotSession }) => {
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

  const focused = sessions.find((s) => s.id === focusId) || null;
  const runningCount = sessions.filter((s) => s.running).length;
  const regimes = board?.regimes?.length ? board.regimes : [...ALL_REGIMES];
  const activeRegimes = new Set(
    (board?.active_regimes?.length
      ? board.active_regimes
      : sessions.filter((s) => s.running).map((s) => s.regime || 'COMPRESSION')
    ).map((r) => r.toUpperCase()),
  );

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
    void apiFetch('/api/robot-desk/start', {
      method: 'POST',
      body: JSON.stringify({
        account_id: launchAccountId,
        epic: launchEpic,
        display_name: m?.display_name || launchEpic,
        lot_size: lotN,
        trading_enabled: true,
      }),
    })
      .then((res: { session: RobotSession }) => {
        setFocusId(res.session.id);
        setShowDeploy(false);
        void refresh();
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Deploy failed'))
      .finally(() => setBusy(false));
  };

  const startOne = async (s: RobotSession) => {
    setBusy(true);
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

  const filteredLaunch = useMemo(() => launchMarkets, [launchMarkets]);

  return (
    <div>
      <PageHeader
        kicker="VS SYSTEM // MULTI-CLIENT"
        title="Robot board"
        stats={[
          { label: 'Units', value: sessions.length },
          { label: 'Online', value: runningCount },
          { label: 'Feeds', value: `${board?.feed_contributing ?? 0}/${board?.feed_sender_count ?? 0}` },
        ]}
        actions={
          <button className="cmd-btn cmd-btn--primary" type="button" onClick={() => setShowDeploy((v) => !v)}>
            {showDeploy ? 'Close' : '+ Deploy'}
          </button>
        }
      />

      {error && <div className="cmd-banner cmd-banner--err">{error}</div>}
      {busy && <div className="cmd-banner cmd-banner--busy mono">Syncing…</div>}

      {showDeploy && (
        <section className="cmd-panel cmd-deploy">
          <div className="cmd-section-title">Deploy robot</div>
          <p className="cmd-deploy-hint mono">Izvēlies kontu → meklē GOLD / XAU → lot → Deploy</p>
          <div className="cmd-deploy-row">
            <select
              className="cmd-select"
              value={launchAccountId ?? ''}
              onChange={(e) => setLaunchAccountId(Number(e.target.value))}
            >
              {launchAccounts.map((a) => (
                <option key={a.account_id} value={a.account_id}>
                  {a.client_name} · #{a.account_id} ({a.environment})
                </option>
              ))}
            </select>
            <MarketSearchPicker
              markets={filteredLaunch}
              value={launchEpic}
              disabled={busy}
              onChange={(epic, m) => {
                setLaunchEpic(epic);
                if (m) setLaunchLot(String(m.lot_size || m.min_lot || 0.1));
              }}
            />
            <input
              className="cmd-input"
              style={{ maxWidth: 80 }}
              value={launchLot}
              onChange={(e) => setLaunchLot(e.target.value)}
              aria-label="Lot size"
            />
            <button className="cmd-btn cmd-btn--go" type="button" disabled={busy} onClick={deploy}>
              Deploy
            </button>
          </div>
        </section>
      )}

      {!showDeploy && (
        <section className="cmd-panel" style={{ marginBottom: '1rem' }}>
          <div className="cmd-section-title">Regimes</div>
          <div className="cmd-chip-row">
            {regimes.map((r) => {
              const name = r.toUpperCase();
              const live = activeRegimes.has(name);
              const focusHit = (focused?.regime || '').toUpperCase() === name;
              return (
                <span key={name} className={`cmd-chip ${live ? 'live' : ''} ${focusHit ? 'focus' : ''}`}>
                  {name}
                </span>
              );
            })}
          </div>
        </section>
      )}

      <div className={`cmd-robot-stage ${focused ? 'has-focus' : 'no-focus'} ${sessions.length === 0 ? 'empty' : ''}`}>
        <div className="cmd-unit-grid">
          {sessions.length === 0 && !busy && (
            <div className="cmd-empty cmd-empty--board">
              <p>Nav robotu.</p>
              <button
                className="cmd-btn cmd-btn--primary"
                type="button"
                onClick={() => setShowDeploy(true)}
              >
                + Deploy
              </button>
            </div>
          )}
          {sessions.map((s) => {
            const p = posture(s);
            return (
              <button
                key={s.id}
                type="button"
                className={`cmd-unit ${s.running ? 'on' : 'off'} ${focusId === s.id ? 'active' : ''}`}
                onClick={() => setFocusId(s.id)}
              >
                <div className="cmd-unit-head">
                  <span>{(s.client_name || s.account_name).toUpperCase()}</span>
                  <span className="cmd-unit-dot" />
                </div>
                <div className="cmd-unit-market">{s.display_name}</div>
                <div className={`cmd-unit-posture ${p.kind}`}>{p.label}</div>
                <div className="cmd-unit-row mono">
                  <span>MID</span>
                  <strong>{fmtNum(s.last_mid)}</strong>
                </div>
                <div className="cmd-unit-row mono">
                  <span>UPL</span>
                  <strong className={(s.unrealized || 0) >= 0 ? 'pos' : 'neg'}>{fmtNum(s.unrealized)}</strong>
                </div>
              </button>
            );
          })}
        </div>

        {focused && (
          <section className="cmd-panel cmd-focus">
            <div className="cmd-kicker">Focus unit</div>
            <div className="cmd-focus-name">
              {(focused.client_name || focused.account_name).toUpperCase()} · {focused.display_name}
            </div>
            <div className={`cmd-unit-posture ${posture(focused).kind}`}>{posture(focused).label}</div>
            <div className="cmd-page-actions">
              <button className="cmd-btn cmd-btn--go" type="button" disabled={busy || focused.running} onClick={() => void startOne(focused)}>
                Start
              </button>
              <button className="cmd-btn cmd-btn--stop" type="button" disabled={busy || !focused.running} onClick={() => void stopOne(focused)}>
                Stop
              </button>
            </div>
            <div className="cmd-focus-metrics mono">
              <div><span>MID</span><strong>{fmtNum(focused.last_mid)}</strong></div>
              <div><span>10s</span><strong>{focused.ohlc_10s?.market || 'SEEDING'}</strong></div>
              <div><span>FEEDS</span><strong>{focused.feed_contributing ?? 0}/{focused.feed_sender_count ?? 0}</strong></div>
              <div><span>SL</span><strong>{fmtNum(focused.safety_sl)}</strong></div>
              <div><span>UPL</span><strong className={(focused.unrealized || 0) >= 0 ? 'pos' : 'neg'}>{fmtNum(focused.unrealized)}</strong></div>
              <div><span>LOT</span><strong>{focused.lot_size}</strong></div>
            </div>
            <div className="cmd-focus-log mono">{lastLog(focused)}</div>
          </section>
        )}
      </div>
    </div>
  );
}
