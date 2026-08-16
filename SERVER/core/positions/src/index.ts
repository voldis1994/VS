/** Position manager façade — broker remains authoritative for execution state. */

export type LocalPosition = {
  localPositionId: string;
  brokerPositionId: string | null;
  accountId: string;
  clientId: string;
  instrument: string;
  direction: 'BUY' | 'SELL';
  size: number;
  entry: number | null;
  stop: number | null;
  takeProfit: number | null;
  state: 'OPEN' | 'CLOSING' | 'CLOSED' | 'UNKNOWN';
  realizedPnl: number | null;
  unrealizedPnl: number | null;
  updatedAt: string;
};

export function emptyPositionBook(): LocalPosition[] {
  return [];
}
