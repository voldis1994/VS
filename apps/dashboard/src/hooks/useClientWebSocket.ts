import { useEffect, useRef, useState } from 'react';
import { getClientToken } from './useClientApi';

const WS_BASE =
  import.meta.env.VITE_CLIENT_WS_URL ||
  import.meta.env.VITE_WS_URL?.replace(/\/ws$/, '/ws/client') ||
  `ws://${window.location.hostname}:3000/ws/client`;

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
    if (!token) {
      setOnline(false);
      return;
    }
    let closed = false;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout>;

    const connect = () => {
      if (closed) return;
      const url = `${WS_BASE}${WS_BASE.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
      ws = new WebSocket(url);
      ws.onopen = () => setOnline(true);
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
