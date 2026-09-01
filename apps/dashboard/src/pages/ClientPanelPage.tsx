import { useCallback, useEffect, useMemo, useState } from 'react';
import { Logo } from '../components/Logo';
import { clientFetch, getClientToken, setClientToken } from '../hooks/useClientApi';
import { useClientWebSocket } from '../hooks/useClientWebSocket';

type Market = {
  instrument_id: number;
  epic: string;
  symbol: string;
  display_name: string;
  category: string;
  min_lot: number;
  max_lot: number;
  lot_step: number;
};

type LiveTrade = {
  market: string;
  display_name: string;
  side: 'BUY' | 'SELL';
  trade_type: string;
  regime?: string | null;
  lot_size: number;
  entry_price: number | null;
  status: 'OPEN';
} | null;

type Status = {
  client_id: number;
  client_name: string;
  connection_ok?: boolean;
  connection_status?: 'ONLINE' | 'LOST' | 'ERROR';
  /** CONFIRMED runtime — green logo only when RUNNING */
  robot_status: 'RUNNING' | 'STARTING' | 'STOPPED' | 'ERROR';
  requested_status?: 'RUNNING' | 'STOPPED';
  pipeline_healthy?: boolean;
  market_analyzed?: boolean;
  broker_status?: 'CONNECTED' | 'DEGRADED' | 'UNKNOWN';
  last_broker_ok_at?: string | null;
  broker_error?: string | null;
  status_reason?: string | null;
  market: string | null;
  display_name: string | null;
  lot_size: number | null;
  live_trade: LiveTrade;
};

function roundLot(n: number, step: number) {
  const s = step > 0 ? step : 0.01;
  return Math.round(n / s) * s;
}

function fmtLot(n: number) {
  if (!Number.isFinite(n)) return '—';
  const t = n.toFixed(4).replace(/\.?0+$/, '');
  return t;
}

export function ClientPanelPage() {
  const [token, setToken] = useState<string | null>(() => getClientToken());
  const [accessCode, setAccessCode] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [status, setStatus] = useState<Status | null>(null);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [epic, setEpic] = useState('');
  const [lot, setLot] = useState(0.1);
  const [flash, setFlash] = useState<'opened' | 'closed' | null>(null);
  const [closedBanner, setClosedBanner] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = useMemo(
    () => markets.find((m) => m.epic === epic) || null,
    [markets, epic]
  );

  const confirmedRunning = status?.robot_status === 'RUNNING';
  const starting = status?.robot_status === 'STARTING';
  const errorState = status?.robot_status === 'ERROR';
  /** Client requested START — lock config / allow STOP while confirming */
  const requestedActive =
    status?.requested_status === 'RUNNING' || confirmedRunning || starting || errorState;

  const refresh = useCallback(async () => {
    const st = await clientFetch<Status>('/api/client/status');
    setStatus(st);
    if (st.market) setEpic(st.market);
    if (st.lot_size != null) setLot(st.lot_size);
    return st;
  }, []);

  const loadMarkets = useCallback(async () => {
    const res = await clientFetch<{ markets: Market[] }>('/api/client/markets');
    setMarkets(res.markets || []);
    return res.markets || [];
  }, []);

  useEffect(() => {
    if (!token) return;
    setBusy(true);
    Promise.all([refresh(), loadMarkets()])
      .then(([st, mk]) => {
        if (!st.market && mk[0]) {
          setEpic(mk[0].epic);
          setLot(mk[0].min_lot);
        }
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : 'Session error');
        if (String(e).toLowerCase().includes('unauthorized')) {
          setClientToken(null);
          setToken(null);
        }
      })
      .finally(() => setBusy(false));
  }, [token, refresh, loadMarkets]);

  useEffect(() => {
    // Poll while STARTING or RUNNING so bridge confirmation flips to green logo
    if (!token || !requestedActive) return;
    const t = setInterval(() => {
      void refresh().catch(() => undefined);
    }, 3000);
    return () => clearInterval(t);
  }, [token, requestedActive, refresh]);

  const { online } = useClientWebSocket(Boolean(token), (msg) => {
    if (msg.type === 'trade_opened') {
      setFlash('opened');
      setClosedBanner(false);
      void refresh();
      setTimeout(() => setFlash(null), 1600);
    } else if (msg.type === 'trade_closed') {
      setFlash('closed');
      setClosedBanner(true);
      void refresh();
      setTimeout(() => {
        setFlash(null);
        setClosedBanner(false);
      }, 2200);
    } else if (
      msg.type === 'robot_started' ||
      msg.type === 'robot_stopped' ||
      msg.type === 'client_status'
    ) {
      void refresh();
    }
  });

  const login = async () => {
    setLoginError(null);
    setBusy(true);
    try {
      const res = await clientFetch<{ token: string }>('/api/client-auth/login', {
        method: 'POST',
        body: JSON.stringify({ access_code: accessCode.trim() }),
      });
      setClientToken(res.token);
      setToken(res.token);
      setAccessCode('');
    } catch (e) {
      setLoginError(e instanceof Error ? e.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    try {
      await clientFetch('/api/client-auth/logout', { method: 'POST' });
    } catch {
      /* ignore */
    }
    setClientToken(null);
    setToken(null);
    setStatus(null);
  };

  const persistConfig = async (nextEpic: string, nextLot: number) => {
    await clientFetch('/api/client/config', {
      method: 'PUT',
      body: JSON.stringify({ epic: nextEpic, lot_size: nextLot }),
    });
    await refresh();
  };

  const bumpLot = async (dir: -1 | 1) => {
    if (!selected || requestedActive) return;
    const step = selected.lot_step || 0.01;
    const next = Math.min(
      selected.max_lot,
      Math.max(selected.min_lot, roundLot(lot + dir * step, step))
    );
    setLot(next);
    setError(null);
    try {
      await persistConfig(selected.epic, next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lot update failed');
    }
  };

  const onMarketChange = async (value: string) => {
    const m = markets.find((x) => x.epic === value);
    if (!m) return;
    setEpic(m.epic);
    setLot(m.min_lot);
    setError(null);
    try {
      await persistConfig(m.epic, m.min_lot);
      if (requestedActive) {
        const res = await clientFetch<{ status: Status }>('/api/client/start', {
          method: 'POST',
          body: JSON.stringify({ epic: m.epic, lot_size: m.min_lot }),
        });
        setStatus(res.status);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Market update failed');
    }
  };

  const toggleRobot = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (!requestedActive) {
        if (!epic) throw new Error('Select a market first');
        await persistConfig(epic, lot);
        const res = await clientFetch<{ status: Status }>('/api/client/start', {
          method: 'POST',
          body: JSON.stringify({ epic, lot_size: lot }),
        });
        setStatus(res.status);
        if (res.status.robot_status === 'ERROR') {
          setError(res.status.broker_error || 'Start failed — check account / market');
        }
      } else {
        const res = await clientFetch<{ status: Status }>('/api/client/stop', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        setStatus(res.status);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed');
      try {
        await refresh();
      } catch {
        /* ignore */
      }
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <div className="ccp-shell">
        <div className="ccp-phone">
          <div className="ccp-login">
            <Logo size={88} />
            <div className="ccp-brand">VS</div>
            <div className="ccp-title">CLIENT CONTROL</div>
            <label className="ccp-label" htmlFor="ccp-code">
              Access Code
            </label>
            <input
              id="ccp-code"
              className="ccp-input"
              inputMode="text"
              autoComplete="one-time-code"
              placeholder="••••••••••••"
              value={accessCode}
              onChange={(e) => setAccessCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void login();
              }}
            />
            {loginError && <div className="ccp-error">{loginError}</div>}
            <button className="ccp-login-btn" type="button" disabled={busy} onClick={() => void login()}>
              LOGIN
            </button>
          </div>
        </div>
      </div>
    );
  }

  const live = status?.live_trade;
  const statusClass = confirmedRunning
    ? 'run'
    : starting
      ? 'starting'
      : errorState
        ? 'error'
        : 'stop';
  const statusLabel = confirmedRunning
    ? 'RUNNING'
    : starting
      ? 'STARTING'
      : errorState
        ? 'ERROR'
        : 'STOPPED';
  const hintLabel = requestedActive ? 'TAP TO STOP' : 'TAP TO START';

  return (
    <div className="ccp-shell">
      <div className="ccp-phone">
        <header className="ccp-top">
          <div>
            <div className="ccp-top-title">VS CONTROL PANEL</div>
            <div className="ccp-client">{status?.client_name || '…'}</div>
          </div>
          <div
            className={`ccp-conn ${
              !online || status?.connection_status === 'LOST'
                ? 'off'
                : status?.connection_status === 'ERROR' || status?.broker_status === 'DEGRADED'
                  ? 'warn'
                  : 'on'
            }`}
          >
            <span className="ccp-dot" />
            {!online || status?.connection_status === 'LOST'
              ? 'CONNECTION LOST'
              : status?.connection_status === 'ERROR' || status?.broker_status === 'DEGRADED'
                ? 'BROKER ERROR'
                : 'SYSTEM ONLINE'}
          </div>
        </header>

        <section className="ccp-block">
          <div className="ccp-label">MARKET</div>
          <select
            className="ccp-select"
            value={epic}
            disabled={busy || markets.length === 0}
            onChange={(e) => void onMarketChange(e.target.value)}
          >
            {markets.length === 0 && <option value="">No markets — ask admin to pull Capital markets</option>}
            {markets.map((m) => (
              <option key={m.instrument_id} value={m.epic}>
                {m.display_name} · {m.epic}
              </option>
            ))}
          </select>
        </section>

        <section className="ccp-block">
          <div className="ccp-label">LOT SIZE</div>
          <div className="ccp-lot">
            <button type="button" className="ccp-lot-btn" disabled={requestedActive || busy} onClick={() => void bumpLot(-1)}>
              −
            </button>
            <div className="ccp-lot-val">{fmtLot(lot)}</div>
            <button type="button" className="ccp-lot-btn" disabled={requestedActive || busy} onClick={() => void bumpLot(1)}>
              +
            </button>
          </div>
          {selected && (
            <div className="ccp-lot-meta">
              min {fmtLot(selected.min_lot)} · max {fmtLot(selected.max_lot)} · step{' '}
              {fmtLot(selected.lot_step)}
            </div>
          )}
        </section>

        <section className="ccp-start">
          <button
            type="button"
            className={`ccp-logo-btn ${
              confirmedRunning ? 'running' : starting ? 'starting' : errorState ? 'error' : 'stopped'
            }`}
            disabled={busy}
            onClick={() => void toggleRobot()}
            aria-label={requestedActive ? 'Stop robot' : 'Start robot'}
          >
            <span
              className={`ccp-logo-spin ${
                confirmedRunning ? 'on' : starting ? 'pulse' : ''
              }`}
            >
              <Logo size={132} />
            </span>
          </button>
          <div className={`ccp-status ${statusClass}`}>{statusLabel}</div>
          <div className="ccp-hint">
            {errorState
              ? status?.broker_error || status?.status_reason || 'SYSTEM ERROR — TAP TO STOP'
              : starting
                ? 'WAITING FOR MARKET READER'
                : hintLabel}
          </div>
        </section>

        <section className={`ccp-live ${flash === 'opened' ? 'flash-open' : ''} ${flash === 'closed' ? 'flash-close' : ''}`}>
          <div className="ccp-live-title">LIVE TRADE</div>
          {closedBanner && !live ? (
            <div className="ccp-live-body">
              <div className="ccp-live-state">TRADE CLOSED</div>
            </div>
          ) : live ? (
            <div className="ccp-live-body">
              <div className="ccp-live-state">TRADE OPENED</div>
              <div className="ccp-live-market">{live.display_name || live.market}</div>
              <div className="ccp-live-type">{live.trade_type}</div>
              {live.regime && live.regime !== 'UNKNOWN' && (
                <div className="ccp-live-regime">{live.regime}</div>
              )}
              <div className="ccp-live-lot">{fmtLot(live.lot_size)} LOT</div>
              {live.entry_price != null && (
                <div className="ccp-live-entry">ENTRY {live.entry_price}</div>
              )}
            </div>
          ) : confirmedRunning ? (
            <div className="ccp-live-body">
              <div className="ccp-live-wait">WAITING FOR TRADE</div>
            </div>
          ) : starting ? (
            <div className="ccp-live-body">
              <div className="ccp-live-wait">CONNECTING PIPELINE</div>
            </div>
          ) : errorState ? (
            <div className="ccp-live-body">
              <div className="ccp-live-wait">PIPELINE ERROR</div>
            </div>
          ) : (
            <div className="ccp-live-body">
              <div className="ccp-live-wait dim">NO ACTIVE ROBOT</div>
            </div>
          )}
        </section>

        {error && <div className="ccp-error">{error}</div>}

        <button type="button" className="ccp-logout" onClick={() => void logout()}>
          LOGOUT
        </button>
      </div>
    </div>
  );
}
