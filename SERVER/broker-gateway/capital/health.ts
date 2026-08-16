/**
 * Capital.com broker gateway façade — CONFIG_REQUIRED when secrets absent.
 * Does NOT place trades. Does NOT invent CONNECTED.
 */

export type BrokerHealthState =
  | 'CONNECTED'
  | 'DISCONNECTED'
  | 'CONFIG_REQUIRED'
  | 'ERROR';

export type BrokerHealth = {
  state: BrokerHealthState;
  environment: 'demo' | 'live' | 'unknown';
  detail: string;
  base_url: string | null;
  secrets_present: boolean;
  checked_at: string;
};

function capitalComBaseUrl(environment: string): string {
  return environment === 'live'
    ? 'https://api-capital.backend-capital.com'
    : 'https://demo-api-capital.backend-capital.com';
}

function secretsPresent(): boolean {
  const key = (process.env.CAPITAL_API_KEY || process.env.CAPITAL_API_KEY_ID || '').trim();
  const login = (process.env.CAPITAL_LOGIN || process.env.CAPITAL_IDENTIFIER || '').trim();
  const password = (process.env.CAPITAL_PASSWORD || process.env.CAPITAL_API_PASSWORD || '').trim();
  if (!key || !login || !password) return false;
  if (/CHANGE_ME|changeme|your_/i.test(`${key}${login}${password}`)) return false;
  return true;
}

/** Read-only. Never authenticates. Never invents CONNECTED. */
export function classifyBrokerConfig(): BrokerHealth {
  const envRaw = (process.env.CAPITAL_ENV || process.env.CAPITAL_ENVIRONMENT || 'demo').toLowerCase();
  const environment = envRaw === 'live' ? 'live' : envRaw === 'demo' ? 'demo' : 'unknown';
  const present = secretsPresent();
  if (!present) {
    return {
      state: 'CONFIG_REQUIRED',
      environment,
      detail: 'Capital credentials absent or placeholder on VS-CORE-01',
      base_url: null,
      secrets_present: false,
      checked_at: new Date().toISOString(),
    };
  }
  return {
    state: 'DISCONNECTED',
    environment: environment === 'unknown' ? 'demo' : environment,
    detail: 'credentials present — session not proven in this probe',
    base_url: capitalComBaseUrl(environment === 'live' ? 'live' : 'demo'),
    secrets_present: true,
    checked_at: new Date().toISOString(),
  };
}

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
