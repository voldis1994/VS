import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clientFetch, getClientToken, setClientToken } from '../../hooks/useClientApi';
import { useClientWebSocket } from '../../hooks/useClientWebSocket';
import { fmtLot, roundLot } from '../lib/format';
import type { ClientQuote, DeskStatus, Market } from '../types';

const PRICE_HISTORY_MAX = 90;
const MAX_MARKETS = 3;

export function useDesk() {
  const [token, setToken] = useState<string | null>(() => getClientToken());
  const [accessCode, setAccessCode] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<DeskStatus | null>(null);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [epics, setEpics] = useState<string[]>([]);
  const [focusEpic, setFocusEpic] = useState('');
  const [budgetPct, setBudgetPct] = useState(25);
  const [lot, setLot] = useState(0.1);
  const [quote, setQuote] = useState<ClientQuote | null>(null);
  const [priceHistory, setPriceHistory] = useState<number[]>([]);
  const [flash, setFlash] = useState<'opened' | 'closed' | null>(null);
  const [closedBanner, setClosedBanner] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tradesOpen, setTradesOpen] = useState(true);
  const budgetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selected = useMemo(
    () => markets.find((m) => m.epic === focusEpic) || null,
    [markets, focusEpic]
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
    const nextEpics =
      Array.isArray(st.markets) && st.markets.length
        ? st.markets
        : st.market
          ? [st.market]
          : [];
    if (nextEpics.length) {
      setEpics(nextEpics);
      setFocusEpic((prev) => (nextEpics.includes(prev) ? prev : nextEpics[0]!));
    }
    if (st.budget_pct != null) setBudgetPct(st.budget_pct);
    if (st.lot_size != null) setLot(st.lot_size);
    return st;
  }, []);

  const refreshQuote = useCallback(async () => {
    try {
      const q = await clientFetch<ClientQuote>(
        `/api/client/quote${focusEpic ? `?epic=${encodeURIComponent(focusEpic)}` : ''}`
      );
      setQuote(q);
      pushPrice(q.mid);
    } catch {
      /* quote optional until market selected */
    }
  }, [pushPrice, focusEpic]);

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
        const have =
          Array.isArray(st.markets) && st.markets.length
            ? st.markets
            : st.market
              ? [st.market]
              : [];
        if (!have.length && mk[0]) {
          setEpics([mk[0].epic]);
          setFocusEpic(mk[0].epic);
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
    if (!token || !focusEpic) return;
    void refreshQuote();
    const t = setInterval(() => void refreshQuote(), 2000);
    return () => clearInterval(t);
  }, [token, focusEpic, refreshQuote]);

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

  const persistConfig = async (nextEpics: string[], nextBudget: number, nextLot?: number) => {
    const cleaned = [...new Set(nextEpics.map((e) => e.trim()).filter(Boolean))].slice(0, MAX_MARKETS);
    if (!cleaned.length) throw new Error('Select 1–3 markets');
    await clientFetch('/api/client/config', {
      method: 'PUT',
      body: JSON.stringify({
        epics: cleaned,
        budget_pct: nextBudget,
        lot_size: nextLot ?? lot,
      }),
    });
    setPriceHistory([]);
    await Promise.all([refresh(), refreshQuote()]);
  };

  const toggleMarket = async (epic: string) => {
    if (requestedActive) return;
    const has = epics.includes(epic);
    let next: string[];
    if (has) {
      if (epics.length <= 1) {
        setError('Keep at least 1 market');
        return;
      }
      next = epics.filter((e) => e !== epic);
    } else {
      if (epics.length >= MAX_MARKETS) {
        setError('Max 3 markets');
        return;
      }
      next = [...epics, epic];
    }
    setEpics(next);
    setFocusEpic(next.includes(focusEpic) ? focusEpic : next[0]!);
    setError(null);
    try {
      const m = markets.find((x) => x.epic === next[0]);
      await persistConfig(next, budgetPct, m?.min_lot ?? lot);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Market update failed');
    }
  };

  const bumpBudget = async (dir: -1 | 1) => {
    if (requestedActive) return;
    const next = Math.min(100, Math.max(1, budgetPct + dir * 5));
    setBudgetPct(next);
    setError(null);
    try {
      await persistConfig(epics, next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Budget update failed');
    }
  };

  const setBudgetInput = (raw: string) => {
    if (requestedActive) return;
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    setBudgetPct(n);
    setError(null);
    if (budgetTimer.current) clearTimeout(budgetTimer.current);
    budgetTimer.current = setTimeout(() => {
      const clamped = Math.min(100, Math.max(1, Math.round(n)));
      setBudgetPct(clamped);
      void persistConfig(epics, clamped).catch((e) => {
        setError(e instanceof Error ? e.message : 'Budget update failed');
      });
    }, 450);
  };

  const startRobot = async () => {
    if (busy || requestedActive) return;
    setBusy(true);
    setError(null);
    try {
      if (!epics.length) throw new Error('Select 1–3 markets first');
      await persistConfig(epics, budgetPct, lot);
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

  const estimatedLot = useMemo(() => {
    if (!selected) return null;
    // Preview only — live size uses Capital equity on the server
    const mid = quote?.mid;
    if (mid == null || !(mid > 0)) return selected.min_lot;
    const factor = selected.category === 'fx' ? 0.033 : 0.05;
    const rough = (100 * (budgetPct / 100)) / (mid * factor);
    return Math.max(selected.min_lot, roundLot(rough, selected.lot_step || 0.01));
  }, [selected, quote?.mid, budgetPct]);

  return {
    token,
    accessCode,
    setAccessCode,
    loginError,
    busy,
    status,
    markets,
    epics,
    epic: focusEpic,
    budgetPct,
    lot,
    estimatedLot,
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
    toggleMarket,
    setFocusEpic,
    bumpBudget,
    setBudgetInput,
    startRobot,
    stopRobot,
    fmtLot,
  };
}
