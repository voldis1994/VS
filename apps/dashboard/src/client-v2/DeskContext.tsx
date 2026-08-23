import { createContext, useContext, type ReactNode } from 'react';
import { useDesk } from './hooks/useDesk';

type DeskContextValue = ReturnType<typeof useDesk>;

const DeskContext = createContext<DeskContextValue | null>(null);

export function DeskProvider({ children }: { children: ReactNode }) {
  const desk = useDesk();
  return <DeskContext.Provider value={desk}>{children}</DeskContext.Provider>;
}

export function useDeskContext(): DeskContextValue {
  const ctx = useContext(DeskContext);
  if (!ctx) throw new Error('useDeskContext outside DeskProvider');
  return ctx;
}
