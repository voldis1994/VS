import { useEffect, useRef, useState } from 'react';
import { getClientToken } from './useClientApi';

/** Same-origin by default so public tunnels (cloudflared/ngrok) work for remote clients. */
function clientWsUrl(): string {
  const forced = import.meta.env.VITE_CLIENT_WS_URL;
  if (forced && String(forced).trim()) return String(forced).trim();
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws/client`;
}

type WsMessage = { type: string; [key: string]: unknown };

export function useClientWebSocket(
  enabled: boolean,
  onMessage?: (msg: WsMessage) => void
) {
  const [online, setOnline] = useState(false);
  const cb = useRef(onMessage);
  cb.current = onMessage;

  useEffect(() => {
    if (!enabled) {
      setOnline(false);
      return;
    }
    const token = getClientToken();
    let closed = false;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout>;

    const connect = () => {
      if (closed) return;
      ws = new WebSocket(clientWsUrl());
      ws.onopen = () => {
        if (token) {
          ws?.send(JSON.stringify({ type: 'auth', token }));
        }
      };
      ws.onclose = () => {
        setOnline(false);
        if (!closed) timer = setTimeout(connect, 3000);
      };
      ws.onerror = () => setOnline(false);
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as WsMessage;
          if (msg.type === 'connection_status') setOnline(true);
          if (msg.type === 'error') setOnline(false);
          cb.current?.(msg);
        } catch {
          /* ignore */
        }
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, [enabled]);

  return { online };
}
