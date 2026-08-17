/**
 * Capital.com broker gateway façade — CONFIG_REQUIRED when secrets absent.
 * Does NOT place trades. Does NOT invent CONNECTED.
 */
export type BrokerHealthState = 'CONNECTED' | 'DISCONNECTED' | 'CONFIG_REQUIRED' | 'ERROR';
export type BrokerHealth = {
    state: BrokerHealthState;
    environment: 'demo' | 'live' | 'unknown';
    detail: string;
    base_url: string | null;
    secrets_present: boolean;
    checked_at: string;
};
/** Read-only. Never authenticates. Never invents CONNECTED. */
export declare function classifyBrokerConfig(): BrokerHealth;
export type CanonicalBrokerAccount = {
    broker: 'capital';
    account_id: string;
    name: string | null;
    currency: string | null;
    balance: number | null;
};
export type CanonicalBrokerQuote = {
    broker: 'capital';
    symbol: string;
    bid: number;
    ask: number;
    mid: number;
    spread: number;
    source_timestamp: string;
};
