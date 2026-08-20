import { WebSocket } from 'ws';

export class TelemetryBroadcaster {
  private clients = new Set<WebSocket>();
  private latestMetrics: Record<string, unknown> = {};

  addClient(socket: WebSocket): void {
    this.clients.add(socket);
    if (Object.keys(this.latestMetrics).length > 0) {
      socket.send(JSON.stringify(this.latestMetrics));
    }
  }

  removeClient(socket: WebSocket): void {
    this.clients.delete(socket);
  }

  broadcast(data: Record<string, unknown>): void {
    this.latestMetrics = { ...this.latestMetrics, ...data };
    const payload = JSON.stringify(data);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  getLatestMetrics(): Record<string, unknown> {
    return this.latestMetrics;
  }
}
