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
  git_sha?: string;
  entry_brain?: string;
  sl?: string;
  trend_minutes?: number;
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
