/**
 * Canonical broker types — Capital.com objects stop at the gateway.
 * All other VS services use these types only.
 */

export type BrokerAccount = {
  broker: 'capital';
  accountId: string;
  name: string | null;
  currency: string | null;
  status: string | null;
};

export type BrokerBalance = {
  broker: 'capital';
  accountId: string;
  balance: number | null;
  available: number | null;
  deposit: number | null;
  profitLoss: number | null;
  currency: string | null;
};

export type BrokerInstrument = {
  broker: 'capital';
  symbol: string;
  epic: string;
  name: string | null;
  type: string | null;
  minDealSize: number | null;
  currency: string | null;
};

export type BrokerQuote = {
  broker: 'capital';
  symbol: string;
  epic: string;
  bid: number;
  ask: number;
  mid: number;
  spread: number;
  sourceTimestamp: string;
  receivedTimestamp: string;
};

export type BrokerOrderRequest = {
  broker: 'capital';
  epic: string;
  direction: 'BUY' | 'SELL';
  size: number;
  stopLevel?: number | null;
  limitLevel?: number | null;
  clientOrderId: string;
};

export type BrokerOrder = {
  broker: 'capital';
  orderId: string;
  clientOrderId: string | null;
  epic: string;
  direction: 'BUY' | 'SELL';
  size: number;
  status: string;
  averageFillPrice: number | null;
  createdAt: string;
};

export type BrokerFill = {
  broker: 'capital';
  fillId: string;
  orderId: string;
  epic: string;
  direction: 'BUY' | 'SELL';
  size: number;
  price: number;
  filledAt: string;
};

export type BrokerPosition = {
  broker: 'capital';
  positionId: string;
  epic: string;
  direction: 'BUY' | 'SELL';
  size: number;
  openLevel: number | null;
  stopLevel: number | null;
  limitLevel: number | null;
  unrealizedPnl: number | null;
};

export type BrokerError = {
  broker: 'capital';
  code: string;
  message: string;
  retryable: boolean;
  httpStatus: number | null;
};

export function mapCapitalError(input: {
  httpStatus?: number | null;
  bodyCode?: string | null;
  message?: string | null;
}): BrokerError {
  const http = input.httpStatus ?? null;
  const code = (input.bodyCode || 'BROKER_ERROR').toUpperCase();
  const retryable =
    http === 429 || http === 502 || http === 503 || http === 504 || code.includes('TIMEOUT');
  return {
    broker: 'capital',
    code,
    message: input.message || code,
    retryable,
    httpStatus: http,
  };
}
