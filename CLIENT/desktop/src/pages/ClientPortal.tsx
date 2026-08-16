import { useCallback, useEffect, useMemo, useState } from 'react';
import { clientFetch, getClientToken, setClientToken } from '../lib/clientApi';

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

type Status = {
  client_id: number;
  client_name: string;
  robot_status: 'RUNNING' | 'STARTING' | 'STOPPED' | 'ERROR';
  requested_status?: 'RUNNING' | 'STOPPED';
  status_reason?: string | null;
  broker_error?: string | null;
  market: string | null;
  display_name: string | null;
  lot_size: number | null;
  live_trade?: {
    market: string;
    display_name: string;
    side: string;
    lot_size: number;
    entry_price: number | null;
  } | null;
};

const LOT_PRESETS = [0.01, 0.05, 0.1, 0.5, 1];

function roundLot(n: number, step: number) {
  const s = step > 0 ? step : 0.01;
  return Math.round(n / s) * s;
}

function clampLot(n: number, m: Market | null) {
  if (!m) return n;
  return Math.min(m.max_lot, Math.max(m.min_lot, roundLot(n, m.lot_step || 0.01)));
}

export function ClientPortal() {
  const [token, setToken] = useState<string | null>(() => getClientToken());
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [epic, setEpic] = useState('');
  const [lot, setLot] = useState(0.1);
  const [error, setError] = useState<string | null>(null);
  const [savedHint, setSavedHint] = useState<string | null>(null);

  const selected = useMemo(() => markets.find((m) => m.epic === epic) || null, [markets, epic]);
  const running = status?.robot_status === 'RUNNING';
  const starting = status?.robot_status === 'STARTING';
  const locked =
    status?.requested_status === 'RUNNING' || running || starting || status?.robot_status === 'ERROR';

  const refresh = useCallback(async () => {
    const st = await clientFetch<Status>('/api/client/status');
    setStatus(st);
    if (st.market) setEpic(st.market);
    if (st.lot_size != null) setLot(Number(st.lot_size));
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
    if (!token || !locked) return;
    const t = setInterval(() => {
      void refresh().catch(() => undefined);
    }, 3000);
    return () => clearInterval(t);
  }, [token, locked, refresh]);

  const doLogin = async () => {
    setLoginError(null);
    setBusy(true);
    try {
      const res = await clientFetch<{ token: string }>('/api/client-auth/login', {
        method: 'POST',
        body: JSON.stringify({ login: login.trim(), password: password.trim() }),
      });
      setClientToken(res.token);
      setToken(res.token);
      setPassword('');
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
    setSavedHint('Market + lot saved');
    setTimeout(() => setSavedHint(null), 2000);
  };

  const applyLot = async (raw: number) => {
    if (locked || !selected) return;
    const next = clampLot(raw, selected);
    setLot(next);
    setError(null);
    try {
      await persistConfig(epic || selected.epic, next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lot update failed');
    }
  };

  const onMarketChange = async (next: string) => {
    if (locked) return;
    setEpic(next);
    const m = markets.find((x) => x.epic === next) || null;
    const nextLot = clampLot(lot, m);
    setLot(nextLot);
    setError(null);
    try {
      await persistConfig(next, nextLot);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Market update failed');
    }
  };

  const toggleRobot = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!locked) {
        if (!epic) throw new Error('Select a market first');
        await persistConfig(epic, lot);
        await clientFetch('/api/client/start', { method: 'POST', body: '{}' });
      } else {
        await clientFetch('/api/client/stop', { method: 'POST', body: '{}' });
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Robot action failed');
      await refresh().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <div className="app">
        <div className="brand">VS</div>
        <div className="sub">CLIENT PORTAL</div>
        <div className="card">
          <div className="welcome">LOGIN</div>
          <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            Outside home Wi‑Fi: connect WireGuard first, then open http://10.77.0.1:3000/
          </p>
          <label className="field">
            <span>Login</span>
            <input
              value={login}
              onChange={(e) => setLogin(e.target.value)}
              autoComplete="username"
              placeholder="client login"
            />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              placeholder="••••••••"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void doLogin();
              }}
            />
          </label>
          {loginError ? <div className="err">{loginError}</div> : null}
          <button
            className="primary"
            type="button"
            disabled={busy || !login || !password}
            onClick={() => void doLogin()}
          >
            {busy ? '…' : 'SIGN IN'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="brand">VS</div>
      <div className="sub">CONTROL PANEL</div>
      <div className={`conn ${running ? 'ok' : starting ? 'warn' : 'bad'}`}>
        ROBOT {status?.robot_status || (busy ? 'LOADING' : 'STOPPED')}
      </div>

      <div className="card">
        <div className="welcome">WELCOME</div>
        <div className="name">{status?.client_name || 'Client'}</div>
        {status?.status_reason || status?.broker_error ? (
          <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
            {status.status_reason || status.broker_error}
          </div>
        ) : null}
      </div>

      <div className="card">
        <div className="muted" style={{ fontSize: 11, letterSpacing: '0.12em' }}>
          1. SELECT MARKET
        </div>
        {markets.length === 0 ? (
          <div className="empty">
            NO MARKETS — ask admin to link a broker account to your login
          </div>
        ) : (
          <select
            className="select"
            value={epic}
            disabled={locked || busy}
            onChange={(e) => void onMarketChange(e.target.value)}
          >
            {!epic ? <option value="">— choose market —</option> : null}
            {markets.map((m) => (
              <option key={m.epic} value={m.epic}>
                {m.display_name || m.symbol || m.epic}
              </option>
            ))}
          </select>
        )}
        <div className="row" style={{ marginTop: 10 }}>
          <span>Active</span>
          <span>{status?.display_name || selected?.display_name || '—'}</span>
        </div>
      </div>

      <div className="card">
        <div className="muted" style={{ fontSize: 11, letterSpacing: '0.12em' }}>
          2. LOT SIZE
        </div>
        <div className="lot">
          <button
            type="button"
            disabled={locked || !selected}
            onClick={() => void applyLot(lot - (selected?.lot_step || 0.01))}
          >
            −
          </button>
          <div className="val">{Number(lot).toFixed(2)}</div>
          <button
            type="button"
            disabled={locked || !selected}
            onClick={() => void applyLot(lot + (selected?.lot_step || 0.01))}
          >
            +
          </button>
        </div>
        <div className="presets">
          {LOT_PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              className={Math.abs(lot - p) < 1e-9 ? 'on' : ''}
              disabled={locked || !selected || p < (selected?.min_lot || 0) || p > (selected?.max_lot || 999)}
              onClick={() => void applyLot(p)}
            >
              {p.toFixed(2)}
            </button>
          ))}
        </div>
        {selected ? (
          <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
            Range {selected.min_lot} – {selected.max_lot} (step {selected.lot_step})
          </div>
        ) : null}
        {savedHint ? <div className="conn ok">{savedHint}</div> : null}
      </div>

      {status?.live_trade ? (
        <div className="card">
          <div className="muted" style={{ fontSize: 11 }}>
            OPEN POSITION
          </div>
          <div className="row">
            <span>{status.live_trade.display_name}</span>
            <span>
              {status.live_trade.side} {status.live_trade.lot_size}
            </span>
          </div>
          <div className="row">
            <span>Entry</span>
            <span>{status.live_trade.entry_price ?? '—'}</span>
          </div>
        </div>
      ) : null}

      {error ? <div className="err">{error}</div> : null}

      <div className="start-wrap">
        <button
          type="button"
          className={`start ${locked ? 'stop' : ''}`}
          disabled={busy || (!locked && (!epic || markets.length === 0))}
          onClick={() => void toggleRobot()}
        >
          <div>
            VS
            <small>{locked ? 'STOP' : 'START'}</small>
          </div>
        </button>
      </div>
      <div className="conn">3. START robot — uses your selected market + lot</div>

      <button className="link" type="button" onClick={() => void logout()}>
        Sign out
      </button>
    </div>
  );
}
