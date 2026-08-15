/**
 * Per-client / per-account trading state — START/STOP scoped.
 * STOP one account must not stop other accounts of the same client.
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

function key(clientId: number, accountId: number | null | undefined): string {
  return `${clientId}:${accountId ?? 'any'}`;
}

export class ClientTradingRegistry {
  private byKey = new Map<string, ClientTradingState>();

  ensure(
    clientId: number,
    accountId?: number | null,
    defaults?: Partial<ClientTradingState>
  ): ClientTradingState {
    const k = key(clientId, accountId ?? null);
    let s = this.byKey.get(k);
    if (!s) {
      const now = new Date().toISOString();
      s = {
        client_id: clientId,
        account_id: accountId ?? defaults?.account_id ?? null,
        strategy_profile: defaults?.strategy_profile || 'default',
        risk_profile: defaults?.risk_profile || 'default',
        trading_enabled: false,
        stop_position_policy: defaults?.stop_position_policy || 'LEAVE_OPEN',
        started_at: null,
        stopped_at: null,
        updated_at: now,
      };
      this.byKey.set(k, s);
    }
    return s;
  }

  start(clientId: number, accountId?: number | null): ClientTradingState {
    const s = this.ensure(clientId, accountId ?? null);
    const now = new Date().toISOString();
    s.trading_enabled = true;
    s.started_at = now;
    s.stopped_at = null;
    s.updated_at = now;
    return { ...s };
  }

  /**
   * STOP scoped to client+account. Omitting accountId stops only the `any` bucket,
   * not every account for the client.
   */
  stop(clientId: number, accountId?: number | null): ClientTradingState {
    const s = this.ensure(clientId, accountId ?? null);
    const now = new Date().toISOString();
    s.trading_enabled = false;
    s.stopped_at = now;
    s.updated_at = now;
    return { ...s };
  }

  get(clientId: number, accountId?: number | null): ClientTradingState | undefined {
    return (
      this.byKey.get(key(clientId, accountId ?? null)) ||
      (accountId != null ? this.byKey.get(key(clientId, null)) : undefined)
    );
  }

  isTradingEnabled(clientId: number, accountId?: number | null): boolean {
    const scoped = this.get(clientId, accountId);
    if (scoped) return scoped.trading_enabled === true;
    return false;
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
