import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { apiFetch } from '../../hooks/useApi';

export type DeskStatus = {
  mode?: string;
  live_enabled?: boolean;
  clients?: { active?: number } | number;
  positions_open?: number;
  [key: string]: unknown;
};

export type DeskClient = { id: number; name: string; enabled: boolean };
export type DeskAccount = {
  account_id: number;
  client_id: number;
  client_name: string;
  display_name: string;
  environment: string;
};

type Ctx = {
  status: DeskStatus | null;
  clients: DeskClient[];
  accounts: DeskAccount[];
  selectedClientId: number | null;
  selectedAccountId: number | null;
  setSelectedClientId: (id: number | null) => void;
  setSelectedAccountId: (id: number | null) => void;
  refresh: () => Promise<void>;
};

const CommandDeskContext = createContext<Ctx | null>(null);

export function CommandDeskProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<DeskStatus | null>(null);
  const [clients, setClients] = useState<DeskClient[]>([]);
  const [accounts, setAccounts] = useState<DeskAccount[]>([]);
  const [selectedClientId, setSelectedClientId] = useState<number | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    const [s, c, a] = await Promise.all([
      apiFetch<DeskStatus>('/api/system/status').catch(() => null),
      apiFetch<DeskClient[]>('/api/clients').catch(() => []),
      apiFetch<DeskAccount[]>('/api/trading/accounts').catch(() => []),
    ]);
    if (s) setStatus(s);
    setClients(c);
    setAccounts(a);
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 8000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (!clients.length) {
      setSelectedClientId(null);
      return;
    }
    setSelectedClientId((p) => (p && clients.some((x) => x.id === p) ? p : clients[0]!.id));
  }, [clients]);

  useEffect(() => {
    if (!accounts.length) {
      setSelectedAccountId(null);
      return;
    }
    setSelectedAccountId((p) => {
      if (p && accounts.some((x) => x.account_id === p)) return p;
      const scoped = selectedClientId
        ? accounts.filter((x) => x.client_id === selectedClientId)
        : accounts;
      return scoped[0]?.account_id ?? accounts[0]!.account_id;
    });
  }, [accounts, selectedClientId]);

  const value = useMemo(
    () => ({
      status,
      clients,
      accounts,
      selectedClientId,
      selectedAccountId,
      setSelectedClientId,
      setSelectedAccountId,
      refresh,
    }),
    [status, clients, accounts, selectedClientId, selectedAccountId, refresh]
  );

  return <CommandDeskContext.Provider value={value}>{children}</CommandDeskContext.Provider>;
}

export function useCommandDesk() {
  const ctx = useContext(CommandDeskContext);
  if (!ctx) throw new Error('useCommandDesk outside provider');
  return ctx;
}
