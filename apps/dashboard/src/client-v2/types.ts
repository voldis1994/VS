export type Market = {
  instrument_id: number;
  epic: string;
  symbol: string;
  display_name: string;
  category: string;
  min_lot: number;
  max_lot: number;
  lot_step: number;
};

export type LiveTrade = {
  market: string;
  display_name: string;
  side: 'BUY' | 'SELL';
  trade_type: string;
  regime?: string | null;
  lot_size: number;
  entry_price: number | null;
  status: 'OPEN';
} | null;

export type DeskStatus = {
  client_id: number;
  client_name: string;
  connection_ok?: boolean;
  connection_status?: 'ONLINE' | 'LOST' | 'ERROR';
  robot_status: 'RUNNING' | 'STARTING' | 'STOPPED' | 'ERROR';
  requested_status?: 'RUNNING' | 'STOPPED';
  pipeline_healthy?: boolean;
  market_analyzed?: boolean;
  broker_status?: 'CONNECTED' | 'DEGRADED' | 'UNKNOWN';
  last_broker_ok_at?: string | null;
  broker_error?: string | null;
  status_reason?: string | null;
  market: string | null;
  display_name: string | null;
  markets?: string[];
  lot_size: number | null;
  budget_pct?: number;
  live_trade: LiveTrade;
};

export type ClientQuote = {
  epic: string;
  display_name: string;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  spread: number | null;
  change_pct: number | null;
  regime: string | null;
  updated_at: string;
};

export type RobotPhase = DeskStatus['robot_status'];
