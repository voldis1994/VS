/**
 * Resolve MASTER broker from environment — enables LIVE without desk/DB.
 * Uses CAPITAL_* (already in .env.example) + MASTER_* gates.
 *
 * Primary LIVE venue = Capital.com API (direct).
 * MT4 file bridge is legacy opt-in only (MASTER_ALLOW_MT4_LEGACY) — never preferred
 * over Capital. Good MT4/Check- behaviors are ported into MASTER, not bridged.
 *
 * LIVE connect failure does NOT silently fall back to PAPER (deskBridge parity).
 */
import { PaperBroker, type MasterBroker, Mt4FileBroker } from './broker.js';
import { createCapitalBroker, masterCapitalConnectionId } from './capitalFactory.js';

export type EnvBrokerResult = {
  ok: boolean;
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

export function mt4LegacyAllowed(): boolean {
  return (process.env.MASTER_ALLOW_MT4_LEGACY || '').trim() === 'true';
}

export async function resolveBrokerFromEnv(): Promise<EnvBrokerResult> {
  const wantLive =
    process.env.MASTER_LIVE_ENABLED === 'true' ||
    (process.env.MASTER_MODE || '').toUpperCase() === 'LIVE';

  // 1) Primary LIVE: Capital.com API direct
  if (wantLive && capitalEnvPresent()) {
    const connectionId = masterCapitalConnectionId();
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
      connectionId,
    });
    const opened = await broker.connect();
    if (!opened.ok) {
      // Honest failure — do not swap PaperBroker while LIVE was requested
      return {
        ok: false,
        broker,
        mode: 'LIVE',
        detail: `capital_connect_failed:${opened.detail}`,
      };
    }
    return {
      ok: true,
      broker,
      mode: 'LIVE',
      detail: `capital_env_connected:conn=${connectionId}`,
    };
  }

  // 2) Legacy opt-in MT4 file bridge — only when explicitly allowed AND Capital missing
  const mt4 = (process.env.MASTER_MT4_BRIDGE || '').trim();
  if (mt4 && mt4LegacyAllowed()) {
    const broker = new Mt4FileBroker(mt4);
    const c = await broker.connect();
    return {
      ok: c.ok,
      broker,
      mode: wantLive ? 'LIVE' : 'PAPER',
      detail: c.ok
        ? `mt4_legacy:${mt4}`
        : `mt4_legacy_fail:${c.detail}`,
    };
  }
  if (mt4 && !mt4LegacyAllowed()) {
    // Honest refuse — do not silently attach MT4 as primary LIVE
    const paper = new PaperBroker();
    await paper.connect();
    return {
      ok: false,
      broker: paper,
      mode: 'PAPER',
      detail:
        'MASTER_MT4_BRIDGE set but MASTER_ALLOW_MT4_LEGACY!=true — primary LIVE is Capital.com; refuse MT4 bridge',
    };
  }

  const paper = new PaperBroker();
  await paper.connect();
  if (wantLive && !capitalEnvPresent()) {
    // Honest refuse — never ok:true PAPER while LIVE was requested (UI would show LIVE_RUNNING)
    return {
      ok: false,
      broker: paper,
      mode: 'PAPER',
      detail: 'live_requested_but_CAPITAL_*_missing',
    };
  }
  return { ok: true, broker: paper, mode: 'PAPER', detail: 'paper_default' };
}
