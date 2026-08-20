import { WebSocket } from 'ws';

export type ClientEvent = {
  type: string;
  client_id: number;
  timestamp: string;
  [key: string]: unknown;
};

/** Per-client WebSocket fan-out — never broadcast admin/global telemetry here. */
export class ClientEventHub {
  private sockets = new Map<number, Set<WebSocket>>();

  add(clientId: number, socket: WebSocket): void {
    let set = this.sockets.get(clientId);
    if (!set) {
      set = new Set();
      this.sockets.set(clientId, set);
    }
    set.add(socket);
  }

  remove(clientId: number, socket: WebSocket): void {
    const set = this.sockets.get(clientId);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) this.sockets.delete(clientId);
  }

  emit(clientId: number, event: Omit<ClientEvent, 'client_id' | 'timestamp'> & { type: string }): void {
    const payload: ClientEvent = {
      ...event,
      client_id: clientId,
      timestamp: new Date().toISOString(),
    };
    const raw = JSON.stringify(payload);
    const set = this.sockets.get(clientId);
    if (!set) return;
    for (const socket of set) {
      if (socket.readyState === WebSocket.OPEN) socket.send(raw);
    }
  }
}

let hub: ClientEventHub | null = null;

export function setClientEventHub(h: ClientEventHub): void {
  hub = h;
}

export function emitToClient(
  clientId: number,
  event: Omit<ClientEvent, 'client_id' | 'timestamp'> & { type: string }
): void {
  hub?.emit(clientId, event);
}
