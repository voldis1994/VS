/**
 * Resolve MASTER broker from environment — enables LIVE without desk/DB.
 * Uses CAPITAL_* (already in .env.example) + MASTER_* gates.
 *
 * Primary LIVE venue = Capital.com API (direct).
 * Credential sources (in order when LIVE requested):
 *   1) CAPITAL_* env
 *   2) Brokers-page DB (encrypted credentials) — same Capital.com API, not MT4
 * MT4 file bridge is legacy opt-in only (MASTER_ALLOW_MT4_LEGACY) — never preferred
 * over Capital. Good MT4/Check- behaviors are ported into MASTER, not bridged.
 *
 * LIVE connect failure does NOT silently fall back to PAPER (deskBridge parity).
 */
import { PaperBroker, type MasterBroker, Mt4FileBroker } from './broker.js';
import { loadDeskCapitalCredentials } from './capitalDeskCreds.js';
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

async function connectCapitalLive(input: {
  environment: string;
  apiKey: string;
  identifier: string;
  password: string;
  capitalAccountId?: string | null;
  sourceDetail: string;
}): Promise<EnvBrokerResult> {
  const connectionId = masterCapitalConnectionId();
  const broker = createCapitalBroker({
    environment: input.environment,
    apiKey: input.apiKey,
    identifier: input.identifier,
    password: input.password,
    capitalAccountId: input.capitalAccountId ?? null,
    connectionId,
  });
  const opened = await broker.connect();
  if (!opened.ok) {
    return {
      ok: false,
      broker,
      mode: 'LIVE',
      detail: `capital_connect_failed:${input.sourceDetail}:${opened.detail}`,
    };
  }
  return {
    ok: true,
    broker,
    mode: 'LIVE',
    detail: `${input.sourceDetail}:pool=${connectionId}`,
  };
}

export async function resolveBrokerFromEnv(opts?: {
  /** Optional Brokers DB connection id for desk fallback */
  deskConnectionId?: number | null;
}): Promise<EnvBrokerResult> {
  const wantLive =
    process.env.MASTER_LIVE_ENABLED === 'true' ||
    (process.env.MASTER_MODE || '').toUpperCase() === 'LIVE';

  // 1) Primary LIVE: Capital.com API via env secrets
  if (wantLive && capitalEnvPresent()) {
    return connectCapitalLive({
      environment: (process.env.CAPITAL_ENVIRONMENT || 'demo').trim(),
      apiKey: (process.env.CAPITAL_API_KEY || '').trim(),
      identifier: (process.env.CAPITAL_IDENTIFIER || '').trim(),
      password: (
        process.env.CAPITAL_API_PASSWORD ||
        process.env.CAPITAL_PASSWORD ||
        ''
      ).trim(),
      capitalAccountId: process.env.CAPITAL_ACCOUNT_ID || null,
      sourceDetail: 'capital_env_connected',
    });
  }

  // 2) Same Capital.com API via Brokers-page DB (operator-entered keys)
  if (wantLive && !capitalEnvPresent()) {
    const desk = await loadDeskCapitalCredentials(opts?.deskConnectionId);
    if (desk.ok) {
      return connectCapitalLive({
        environment: desk.creds.environment,
        apiKey: desk.creds.apiKey,
        identifier: desk.creds.identifier,
        password: desk.creds.password,
        capitalAccountId: desk.creds.capitalAccountId,
        sourceDetail: `capital_desk_connected:${desk.creds.detail}`,
      });
    }
    // Fall through — may still refuse honestly below (keep desk detail)
    const paper = new PaperBroker();
    await paper.connect();

    // 3) Legacy MT4 only after Capital env + desk both unavailable
    const mt4 = (process.env.MASTER_MT4_BRIDGE || '').trim();
    if (mt4 && mt4LegacyAllowed()) {
      const broker = new Mt4FileBroker(mt4);
      const c = await broker.connect();
      return {
        ok: c.ok,
        broker,
        mode: 'LIVE',
        detail: c.ok
          ? `mt4_legacy:${mt4}`
          : `mt4_legacy_fail:${c.detail}`,
      };
    }
    if (mt4 && !mt4LegacyAllowed()) {
      return {
        ok: false,
        broker: paper,
        mode: 'PAPER',
        detail:
          'MASTER_MT4_BRIDGE set but MASTER_ALLOW_MT4_LEGACY!=true — primary LIVE is Capital.com; refuse MT4 bridge',
      };
    }

    return {
      ok: false,
      broker: paper,
      mode: 'PAPER',
      detail: `live_requested_but_CAPITAL_*_missing_and_${desk.detail}`,
    };
  }

  // Non-LIVE path: optional legacy MT4 (never default)
  const mt4 = (process.env.MASTER_MT4_BRIDGE || '').trim();
  if (mt4 && mt4LegacyAllowed()) {
    const broker = new Mt4FileBroker(mt4);
    const c = await broker.connect();
    return {
      ok: c.ok,
      broker,
      mode: 'PAPER',
      detail: c.ok
        ? `mt4_legacy:${mt4}`
        : `mt4_legacy_fail:${c.detail}`,
    };
  }
  if (mt4 && !mt4LegacyAllowed()) {
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
  return { ok: true, broker: paper, mode: 'PAPER', detail: 'paper_default' };
}
