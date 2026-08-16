/** Shared contracts — no runtime secrets. */

export type ProductRole = 'SERVER' | 'ADMIN' | 'CLIENT';

export type SystemReadyState = {
  process_ready: boolean;
  system_ready: boolean;
  trading_ready: boolean;
};

export type TradingDirection = 'LONG' | 'SHORT' | 'NONE';

export type CapitalEnvironment = 'LIVE' | 'DEMO';

/** Explicit only — never silent LIVE→DEMO fallback. */
export function parseCapitalEnv(raw: string | undefined): CapitalEnvironment | 'CONFIG_REQUIRED' {
  const v = (raw || '').trim().toUpperCase();
  if (v === 'LIVE' || v === 'DEMO') return v;
  return 'CONFIG_REQUIRED';
}
