/**
 * LIVE smoke — attempts real Capital session when CAPITAL_* env OR Brokers DB
 * desk credentials are available (same resolve path as Start LIVE).
 * Exits 0 with skipped=true when neither source has credentials (honest, not fake LIVE).
 *
 *   npx tsx src/master/scripts/liveSmoke.ts
 */
import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'fs';
import { capitalEnvPresent, resolveBrokerFromEnv } from '../envBroker.js';
import { classifyLiveSmokeBroker } from '../liveSmokeGate.js';
import { GOLD_SPEC } from '../pipeline.js';

async function main() {
  const report: Record<string, unknown> = {
    ts: new Date().toISOString(),
    capital_env_present: capitalEnvPresent(),
    master_live_enabled: process.env.MASTER_LIVE_ENABLED === 'true',
  };

  if (process.env.MASTER_LIVE_ENABLED !== 'true') {
    process.env.MASTER_LIVE_ENABLED = 'true';
    report.note = 'temporarily set MASTER_LIVE_ENABLED for smoke';
  }

  const resolved = await resolveBrokerFromEnv();
  report.broker = resolved.broker.name;
  report.mode = resolved.mode;
  report.resolve_detail = resolved.detail;
  report.resolve_ok = resolved.ok;

  const gate = classifyLiveSmokeBroker(resolved);
  if (gate.action === 'skip') {
    report.status = 'SKIPPED';
    report.detail = gate.detail;
    console.log(JSON.stringify(report, null, 2));
    const dir = process.env.ARTIFACT_DIR || '/opt/cursor/artifacts';
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/vs_master_live_smoke.json`, JSON.stringify(report, null, 2));
    return;
  }

  if (gate.action === 'fail') {
    report.status = 'FAIL';
    report.reason = gate.detail;
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return;
  }

  report.credential_source = gate.credentialSource;
  report.detail = resolved.detail;

  const quote = await resolved.broker.getQuote(process.env.MASTER_EPIC || GOLD_SPEC.epic);
  const acct = await resolved.broker.getAccount();
  const positions = await resolved.broker.listOpenPositions();
  report.quote = quote
    ? { bid: quote.bid, ask: quote.ask, mid: quote.mid, spread: quote.spread, epic: quote.epic }
    : null;
  report.account = acct;
  report.open_positions = positions.ok ? positions.positions.length : null;
  report.list_ok = positions.ok;
  report.list_detail = positions.detail || null;
  report.status =
    quote && acct && acct.equity > 0 ? 'OK_LIVE_CONNECTED' : 'CONNECTED_PARTIAL';

  console.log(JSON.stringify(report, null, 2));
  const dir = process.env.ARTIFACT_DIR || '/opt/cursor/artifacts';
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/vs_master_live_smoke.json`, JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
