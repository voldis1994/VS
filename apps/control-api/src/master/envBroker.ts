/**
 * Resolve MASTER broker from environment — enables LIVE without desk/DB.
 * Uses CAPITAL_* (already in .env.example) + MASTER_* gates.
 */
import { PaperBroker, type MasterBroker } from './broker.js';
import { createCapitalBroker } from './capitalFactory.js';
import { Mt4FileBroker } from './broker.js';

export type EnvBrokerResult = {
  broker: MasterBroker;
  mode: 'PAPER' | 'LIVE';
  detail: string;
};

export function capitalEnvPresent(): boolean {
  return !!(
    (process.env.CAPITAL_API_KEY || '').trim() &&
    (process.env.CAPITAL_IDENTIFIER || '').trim() &&
    (process.env.CAPITAL_API_PASSWORD || process.env.CAPITAL_PASSWORD || '').trim()
  );
}

export async function resolveBrokerFromEnv(): Promise<EnvBrokerResult> {
  const mt4 = (process.env.MASTER_MT4_BRIDGE || '').trim();
  if (mt4) {
    const broker = new Mt4FileBroker(mt4);
    const c = await broker.connect();
    return {
      broker,
      mode: process.env.MASTER_LIVE_ENABLED === 'true' ? 'LIVE' : 'PAPER',
      detail: c.ok ? `mt4:${mt4}` : `mt4_fail:${c.detail}`,
    };
  }

  const wantLive =
    process.env.MASTER_LIVE_ENABLED === 'true' ||
    (process.env.MASTER_MODE || '').toUpperCase() === 'LIVE';

  if (wantLive && capitalEnvPresent()) {
    const broker = createCapitalBroker({
      environment: (process.env.CAPITAL_ENVIRONMENT || 'demo').trim(),
      apiKey: (process.env.CAPITAL_API_KEY || '').trim(),
      identifier: (process.env.CAPITAL_IDENTIFIER || '').trim(),
      password: (
        process.env.CAPITAL_API_PASSWORD ||
        process.env.CAPITAL_PASSWORD ||
        ''
      ).trim(),
      capitalAccountId: process.env.CAPITAL_ACCOUNT_ID || null,
    });
    const opened = await broker.connect();
    if (!opened.ok) {
      const paper = new PaperBroker();
      await paper.connect();
      return {
        broker: paper,
        mode: 'PAPER',
        detail: `capital_connect_failed:${opened.detail}→paper_fallback`,
      };
    }
    return { broker, mode: 'LIVE', detail: 'capital_env_connected' };
  }

  const paper = new PaperBroker();
  await paper.connect();
  if (wantLive && !capitalEnvPresent()) {
    return {
      broker: paper,
      mode: 'PAPER',
      detail: 'live_requested_but_CAPITAL_*_missing→paper',
    };
  }
  return { broker: paper, mode: 'PAPER', detail: 'paper_default' };
}
