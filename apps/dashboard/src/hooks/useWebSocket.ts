import { useEffect, useRef } from 'react';

const WS_URL = import.meta.env.VITE_WS_URL || `ws://${window.location.hostname}:3000/ws`;

type WsMessage = { type: string; [key: string]: unknown };

const listeners = new Set<(msg: WsMessage) => void>();

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout>;

function connect() {
  ws = new WebSocket(WS_URL);
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data) as WsMessage;
      listeners.forEach((fn) => fn(msg));
    } catch { /* ignore */ }
  };
  ws.onclose = () => {
    reconnectTimer = setTimeout(connect, 3000);
  };
}

export function useWebSocket(onMessage?: (msg: WsMessage) => void) {
  const callbackRef = useRef(onMessage);
  callbackRef.current = onMessage;

  useEffect(() => {
    if (!ws) connect();
    const handler = (msg: WsMessage) => callbackRef.current?.(msg);
    listeners.add(handler);
    return () => { listeners.delete(handler); };
  }, []);
}

export function subscribeWs(fn: (msg: WsMessage) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
