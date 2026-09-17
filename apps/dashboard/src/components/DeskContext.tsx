import { createContext, useContext } from 'react';

export type DeskStatus = {
  market_core?: string;
  execution?: string;
  database?: string;
  mode?: string;
  live_enabled?: boolean;
  open_positions?: number;
  today_executions?: number;
  clients?: { active?: number } | number;
  brokers_live?: number;
  capital_markets?: number;
  capital_senders?: number;
  server_time?: string;
  feeds?: { active?: number; unhealthy?: number };
};

export type DeskClient = {
  id: number;
  name: string;
  enabled: boolean;
};

export type DeskAccount = {
  account_id: number;
  display_name: string;
  broker_name: string;
  environment: string;
  client_id: number;
  client_name: string;
  identifier: string | null;
  capital_market_count?: number;
  account_enabled?: boolean;
};

/** Prefer Capital.com with pulled markets — crypto/other brokers have no epic catalog. */
export function isCapitalAccount(a: DeskAccount): boolean {
  return String(a.broker_name || '').toLowerCase() === 'capital_com';
}

export function pickBestTradingAccount(
  accounts: DeskAccount[],
  clientId?: number | null,
): DeskAccount | null {
  if (!accounts.length) return null;
  const pool = clientId
    ? accounts.filter((a) => a.client_id === clientId)
    : accounts;
  const scope = pool.length ? pool : accounts;
  const capital = scope.filter(isCapitalAccount);
  const withMkts = [...capital].sort(
    (a, b) => (b.capital_market_count || 0) - (a.capital_market_count || 0),
  );
  if (withMkts[0] && (withMkts[0].capital_market_count || 0) > 0) return withMkts[0];
  if (capital[0]) return capital[0];
  const anyMkts = [...scope].sort(
    (a, b) => (b.capital_market_count || 0) - (a.capital_market_count || 0),
  );
  return anyMkts[0] || accounts[0] || null;
}

export type DeskContextValue = {
  status: DeskStatus | null;
  clients: DeskClient[];
  accounts: DeskAccount[];
  selectedClientId: number | null;
  setSelectedClientId: (id: number | null) => void;
  selectedAccountId: number | null;
  setSelectedAccountId: (id: number | null) => void;
  refreshDesk: () => void;
};

export const DeskContext = createContext<DeskContextValue>({
  status: null,
  clients: [],
  accounts: [],
  selectedClientId: null,
  setSelectedClientId: () => undefined,
  selectedAccountId: null,
  setSelectedAccountId: () => undefined,
  refreshDesk: () => undefined,
});

export function useDesk() {
  return useContext(DeskContext);
}
