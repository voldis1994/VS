/**
 * Per-client trading state — START/STOP does not restart VS Core processes.
 * STOP blocks new entries; open positions policy is separate (never accidental close).
 */

export type StopPositionPolicy = 'LEAVE_OPEN' | 'MANAGE_ONLY';

export type ClientTradingState = {
  client_id: number;
  account_id: number | null;
  strategy_profile: string;
  risk_profile: string;
  trading_enabled: boolean;
  stop_position_policy: StopPositionPolicy;
  started_at: string | null;
  stopped_at: string | null;
  updated_at: string;
};

export class ClientTradingRegistry {
  private byClient = new Map<number, ClientTradingState>();

  ensure(clientId: number, defaults?: Partial<ClientTradingState>): ClientTradingState {
    let s = this.byClient.get(clientId);
    if (!s) {
      const now = new Date().toISOString();
      s = {
        client_id: clientId,
        account_id: defaults?.account_id ?? null,
        strategy_profile: defaults?.strategy_profile || 'default',
        risk_profile: defaults?.risk_profile || 'default',
        trading_enabled: false,
        stop_position_policy: defaults?.stop_position_policy || 'LEAVE_OPEN',
        started_at: null,
        stopped_at: null,
        updated_at: now,
      };
      this.byClient.set(clientId, s);
    }
    return s;
  }

  start(clientId: number): ClientTradingState {
    const s = this.ensure(clientId);
    const now = new Date().toISOString();
    s.trading_enabled = true;
    s.started_at = now;
    s.stopped_at = null;
    s.updated_at = now;
    return { ...s };
  }

  /**
   * STOP: immediately block new entries for this client.
   * Does NOT close open positions unless policy explicitly says so (not implemented here —
   * accidental UI close forbidden; LEAVE_OPEN / MANAGE_ONLY only).
   */
  stop(clientId: number): ClientTradingState {
    const s = this.ensure(clientId);
    const now = new Date().toISOString();
    s.trading_enabled = false;
    s.stopped_at = now;
    s.updated_at = now;
    return { ...s };
  }

  get(clientId: number): ClientTradingState | undefined {
    return this.byClient.get(clientId);
  }

  isTradingEnabled(clientId: number): boolean {
    return this.byClient.get(clientId)?.trading_enabled === true;
  }
}

let shared: ClientTradingRegistry | null = null;
export function getClientTradingRegistry(): ClientTradingRegistry {
  if (!shared) shared = new ClientTradingRegistry();
  return shared;
}
export function resetClientTradingRegistryForTests(): void {
  shared = new ClientTradingRegistry();
}
