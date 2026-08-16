import { useCallback, useEffect, useState } from 'react';

export type ClientLive = {
  connection:
    | 'CONNECTING'
    | 'CONNECTED'
    | 'VPN_OFFLINE'
    | 'SERVER_OFFLINE'
    | 'AUTH_FAILED'
    | 'SESSION_EXPIRED';
  clientName: string | null;
  deviceId: string;
  accountRunning: boolean;
  tradingOn: boolean;
  tradingDetail: string;
  marketStatus: string;
  bid: number | null;
  ask: number | null;
  spread: number | null;
  price: number | null;
  lot: number;
  setLot: (n: number) => void;
  toggleTrading: () => Promise<void>;
  positionsCount: number;
  historyHint: string;
  wgHint: string;
};

function deviceId(): string {
  let id = localStorage.getItem('VS_CLIENT_DEVICE_ID');
  if (!id) {
    id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? 'CLIENT-' + crypto.randomUUID().slice(0, 8).toUpperCase()
        : 'CLIENT-PENDING';
    localStorage.setItem('VS_CLIENT_DEVICE_ID', id);
  }
  return id;
}

function authHeaders(): HeadersInit {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  const token = localStorage.getItem('VS_CLIENT_TOKEN') || '';
  if (token) h.authorization = `Bearer ${token}`;
  const session = localStorage.getItem('VS_CLIENT_SESSION') || '';
  if (session) h['x-session-id'] = session;
  return h;
}

export function useClientLive(): ClientLive {
  const [connection, setConnection] = useState<ClientLive['connection']>('CONNECTING');
  const [lot, setLot] = useState(0.1);
  const [tradingOn, setTradingOn] = useState(false);
  const [tradingDetail, setTradingDetail] = useState('STOPPED');
  const [marketStatus, setMarketStatus] = useState('UNKNOWN');
  const [bid, setBid] = useState<number | null>(null);
  const [ask, setAsk] = useState<number | null>(null);
  const [spread, setSpread] = useState<number | null>(null);
  const [price, setPrice] = useState<number | null>(null);
  const [positionsCount, setPositionsCount] = useState(0);
  const [historyHint, setHistoryHint] = useState('NO DATA');
  const id = deviceId();

  useEffect(() => {
    let stop = false;
    let backoff = 2000;
    const base = (localStorage.getItem('VS_CLIENT_API_BASE') || 'http://10.77.0.1:3000').replace(/\/$/, '');

    async function tick() {
      try {
        const health = await fetch(base + '/health', { signal: AbortSignal.timeout(4000) });
        if (!health.ok) throw new Error('health');

        const token = localStorage.getItem('VS_CLIENT_TOKEN') || '';
        if (!token) {
          if (!stop) {
            setConnection('AUTH_FAILED');
            setMarketStatus('UNAUTHORIZED');
            setTradingDetail('Provide VS_CLIENT_TOKEN from enrollment');
          }
          return;
        }

        // Presence via network device heartbeat when session exists
        const session = localStorage.getItem('VS_CLIENT_SESSION') || '';
        if (session) {
          await fetch(base + '/api/v1/network/device/heartbeat', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({}),
          }).catch(() => null);
        }

        const [statusRes, marketRes, posRes] = await Promise.all([
          fetch(base + '/api/v1/system/status', { headers: authHeaders() }),
          fetch(base + '/api/v1/market', { headers: authHeaders() }),
          fetch(base + '/api/v1/position', { headers: authHeaders() }),
        ]);

        if (statusRes.status === 401 || marketRes.status === 401) {
          if (!stop) setConnection('AUTH_FAILED');
          return;
        }
        if (!statusRes.ok) throw new Error('status');

        const status = await statusRes.json();
        const market = marketRes.ok ? await marketRes.json() : null;
        const pos = posRes.ok ? await posRes.json() : null;

        if (stop) return;
        setConnection('CONNECTED');
        setTradingOn(Boolean(status.trading_enabled));
        setTradingDetail(status.trading_enabled ? 'ACTIVE' : 'STOPPED');
        setMarketStatus(String(market?.status || 'NO_DATA'));
        setBid(typeof market?.bid === 'number' ? market.bid : null);
        setAsk(typeof market?.ask === 'number' ? market.ask : null);
        setSpread(typeof market?.spread === 'number' ? market.spread : null);
        const mid =
          typeof market?.bid === 'number' && typeof market?.ask === 'number'
            ? (market.bid + market.ask) / 2
            : null;
        setPrice(mid);
        setPositionsCount(pos?.position ? 1 : 0);
        setHistoryHint(pos?.position ? 'See POSITIONS' : 'NO DATA from server yet');
        backoff = 2000;
      } catch {
        if (!stop) {
          setConnection('SERVER_OFFLINE');
          backoff = Math.min(backoff * 2, 15000);
        }
      }
    }
    const loop = async () => {
      await tick();
      if (!stop) setTimeout(loop, backoff);
    };
    loop();
    return () => {
      stop = true;
    };
  }, []);

  const toggleTrading = useCallback(async () => {
    const base = (localStorage.getItem('VS_CLIENT_API_BASE') || 'http://10.77.0.1:3000').replace(/\/$/, '');
    const token = localStorage.getItem('VS_CLIENT_TOKEN') || '';
    if (!token) {
      setTradingDetail('AUTH REQUIRED');
      setConnection('AUTH_FAILED');
      return;
    }
    const path = tradingOn ? '/api/v1/trading/stop' : '/api/v1/trading/start';
    try {
      const res = await fetch(base + path, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({}),
      });
      if (res.status === 401) {
        setConnection('AUTH_FAILED');
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setTradingDetail(String(body.reason || body.code || `HTTP ${res.status}`));
        return;
      }
      const body = await res.json();
      const enabled = Boolean(body.state?.trading_enabled);
      setTradingOn(enabled);
      setTradingDetail(enabled ? 'ACTIVE' : 'STOPPED');
    } catch {
      setTradingDetail('REQUEST FAILED');
    }
  }, [tradingOn]);

  return {
    connection,
    clientName: localStorage.getItem('VS_CLIENT_NAME'),
    deviceId: id,
    accountRunning: tradingOn,
    tradingOn,
    tradingDetail,
    marketStatus,
    bid,
    ask,
    spread,
    price,
    lot,
    setLot,
    toggleTrading,
    positionsCount,
    historyHint,
    wgHint: localStorage.getItem('VS_WG_STATUS') || 'UNKNOWN',
  };
}
