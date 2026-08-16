import { useEffect, useState } from 'react';

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
  marketStatus: string;
  bid: number | null;
  ask: number | null;
  spread: number | null;
  price: number | null;
  lot: number;
  setLot: (n: number) => void;
  toggleTrading: () => Promise<void>;
  positionsCount: number;
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

export function useClientLive(): ClientLive {
  const [connection, setConnection] = useState<ClientLive['connection']>('CONNECTING');
  const [lot, setLot] = useState(0.1);
  const [tradingOn, setTradingOn] = useState(false);
  const [marketStatus, setMarketStatus] = useState('UNKNOWN');
  const id = deviceId();

  useEffect(() => {
    let stop = false;
    let backoff = 2000;
    const base = localStorage.getItem('VS_CLIENT_API_BASE') || 'http://10.77.0.1:3000';
    const token = localStorage.getItem('VS_CLIENT_TOKEN') || '';

    async function tick() {
      try {
        // Prefer client health; fall back shows SERVER_OFFLINE — never fake CONNECTED
        const health = await fetch(base.replace(/\/$/, '') + '/health', {
          signal: AbortSignal.timeout(4000),
        });
        if (!health.ok) throw new Error('health');
        if (token) {
          // Optional presence via admin path not used; client token path when wired
        }
        if (!stop) {
          setConnection('CONNECTED');
          setMarketStatus('DISCONNECTED'); // honest until market feed authorized for client
          backoff = 2000;
        }
      } catch {
        if (!stop) {
          setConnection((c) => (c === 'CONNECTING' ? 'SERVER_OFFLINE' : 'SERVER_OFFLINE'));
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

  return {
    connection,
    clientName: localStorage.getItem('VS_CLIENT_NAME'),
    deviceId: id,
    accountRunning: tradingOn,
    tradingOn,
    marketStatus,
    bid: null,
    ask: null,
    spread: null,
    price: null,
    lot,
    setLot,
    toggleTrading: async () => {
      // START/STOP = participation flag locally until CLIENT API trading endpoint is authorized
      setTradingOn((v) => !v);
    },
    positionsCount: 0,
    wgHint: localStorage.getItem('VS_WG_STATUS') || 'UNKNOWN',
  };
}
