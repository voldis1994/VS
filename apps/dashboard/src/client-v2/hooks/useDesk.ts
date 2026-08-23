import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clientFetch, getClientToken, setClientToken } from '../../hooks/useClientApi';
import { useClientWebSocket } from '../../hooks/useClientWebSocket';
import { fmtLot, roundLot } from '../lib/format';
import type { ClientQuote, DeskStatus, Market } from '../types';

const PRICE_HISTORY_MAX = 90;

export function useDesk() {
  const [token, setToken] = useState<string | null>(() => getClientToken());
  const [accessCode, setAccessCode] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<DeskStatus | null>(null);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [epic, setEpic] = useState('');
  const [lot, setLot] = useState(0.1);
  const [quote, setQuote] = useState<ClientQuote | null>(null);
  const [priceHistory, setPriceHistory] = useState<number[]>([]);
  const [flash, setFlash] = useState<'opened' | 'closed' | null>(null);
  const [closedBanner, setClosedBanner] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tradesOpen, setTradesOpen] = useState(true);
  const lotInputTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selected = useMemo(
    () => markets.find((m) => m.epic === epic) || null,
    [markets, epic]
  );

  const confirmedRunning = status?.robot_status === 'RUNNING';
  const starting = status?.robot_status === 'STARTING';
  const errorState = status?.robot_status === 'ERROR';
  const requestedActive =
    status?.requested_status === 'RUNNING' || confirmedRunning || starting || errorState;

  const pushPrice = useCallback((mid: number | null) => {
    if (mid == null || !Number.isFinite(mid)) return;
    setPriceHistory((prev) => {
      const next = [...prev, mid];
      return next.length > PRICE_HISTORY_MAX ? next.slice(-PRICE_HISTORY_MAX) : next;
    });
  }, []);

  const refresh = useCallback(async () => {
    const st = await clientFetch<DeskStatus>('/api/client/status');
    setStatus(st);
    if (st.market) setEpic(st.market);
    if (st.lot_size != null) setLot(st.lot_size);
    return st;
  }, []);

  const refreshQuote = useCallback(async () => {
    try {
      const q = await clientFetch<ClientQuote>('/api/client/quote');
      setQuote(q);
      pushPrice(q.mid);
    } catch {
      /* quote optional until market selected */
    }
  }, [pushPrice]);

  const loadMarkets = useCallback(async () => {
    const res = await clientFetch<{ markets: Market[] }>('/api/client/markets');
    setMarkets(res.markets || []);
    return res.markets || [];
  }, []);

  useEffect(() => {
    if (!token) return;
    setBusy(true);
    setPriceHistory([]);
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
    if (!token || !epic) return;
    void refreshQuote();
    const t = setInterval(() => void refreshQuote(), 2000);
    return () => clearInterval(t);
  }, [token, epic, refreshQuote]);

  useEffect(() => {
    if (!token) return;
    const t = setInterval(() => void refresh().catch(() => undefined), requestedActive ? 3000 : 8000);
    return () => clearInterval(t);
  }, [token, requestedActive, refresh]);

  const { online } = useClientWebSocket(Boolean(token), (msg) => {
    if (msg.type === 'trade_opened') {
      setFlash('opened');
      setClosedBanner(false);
      setTradesOpen(true);
      void refresh();
      setTimeout(() => setFlash(null), 1600);
    } else if (msg.type === 'trade_closed') {
      setFlash('closed');
      setClosedBanner(true);
      setTradesOpen(true);
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
    setQuote(null);
    setPriceHistory([]);
  };

  const persistConfig = async (nextEpic: string, nextLot: number) => {
    await clientFetch('/api/client/config', {
      method: 'PUT',
      body: JSON.stringify({ epic: nextEpic, lot_size: nextLot }),
    });
    setPriceHistory([]);
    await Promise.all([refresh(), refreshQuote()]);
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

  const setLotInput = (raw: string) => {
    if (!selected || requestedActive) return;
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    setLot(n);
    setError(null);
    if (lotInputTimer.current) clearTimeout(lotInputTimer.current);
    lotInputTimer.current = setTimeout(() => {
      const step = selected.lot_step || 0.01;
      const clamped = Math.min(selected.max_lot, Math.max(selected.min_lot, roundLot(n, step)));
      setLot(clamped);
      void persistConfig(selected.epic, clamped).catch((e) => {
        setError(e instanceof Error ? e.message : 'Lot update failed');
      });
    }, 450);
  };

  const onMarketChange = async (value: string) => {
    if (requestedActive) return;
    const m = markets.find((x) => x.epic === value);
    if (!m) return;
    setEpic(m.epic);
    setLot(m.min_lot);
    setPriceHistory([]);
    setError(null);
    try {
      await persistConfig(m.epic, m.min_lot);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Market update failed');
    }
  };

  const startRobot = async () => {
    if (busy || requestedActive) return;
    setBusy(true);
    setError(null);
    try {
      if (!epic) throw new Error('Select a market first');
      await persistConfig(epic, lot);
      const res = await clientFetch<{ status: DeskStatus }>('/api/client/start', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setStatus(res.status);
      if (res.status.robot_status === 'ERROR') {
        setError(res.status.broker_error || 'Start failed — check account / market');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Start failed');
      try {
        await refresh();
      } catch {
        /* ignore */
      }
    } finally {
      setBusy(false);
    }
  };

  const stopRobot = async () => {
    if (busy || !requestedActive) return;
    setBusy(true);
    setError(null);
    try {
      const res = await clientFetch<{ status: DeskStatus }>('/api/client/stop', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setStatus(res.status);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Stop failed');
      try {
        await refresh();
      } catch {
        /* ignore */
      }
    } finally {
      setBusy(false);
    }
  };

  const linkOk =
    online &&
    status?.connection_status !== 'LOST' &&
    status?.connection_status !== 'ERROR' &&
    status?.broker_status !== 'DEGRADED';

  return {
    token,
    accessCode,
    setAccessCode,
    loginError,
    busy,
    status,
    markets,
    epic,
    lot,
    quote,
    priceHistory,
    flash,
    closedBanner,
    error,
    tradesOpen,
    setTradesOpen,
    selected,
    confirmedRunning,
    starting,
    errorState,
    requestedActive,
    linkOk,
    online,
    login,
    logout,
    bumpLot,
    setLotInput,
    onMarketChange,
    startRobot,
    stopRobot,
    fmtLot,
  };
}
