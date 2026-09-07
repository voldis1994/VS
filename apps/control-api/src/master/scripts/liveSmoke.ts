/**
 * LIVE smoke — attempts real Capital session when CAPITAL_* present.
 * Exits 0 with skipped=true when credentials missing (honest, not fake LIVE).
 *
 *   npx tsx src/master/scripts/liveSmoke.ts
 */
import { writeFileSync, mkdirSync } from 'fs';
import { capitalEnvPresent, resolveBrokerFromEnv } from '../envBroker.js';
import { GOLD_SPEC } from '../pipeline.js';

async function main() {
  const report: Record<string, unknown> = {
    ts: new Date().toISOString(),
    capital_env_present: capitalEnvPresent(),
    master_live_enabled: process.env.MASTER_LIVE_ENABLED === 'true',
  };

  if (!capitalEnvPresent()) {
    report.status = 'SKIPPED';
    report.detail =
      'CAPITAL_API_KEY / CAPITAL_IDENTIFIER / CAPITAL_API_PASSWORD not set — cannot prove live Capital network path in this environment';
    console.log(JSON.stringify(report, null, 2));
    const dir = process.env.ARTIFACT_DIR || '/opt/cursor/artifacts';
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/vs_master_live_smoke.json`, JSON.stringify(report, null, 2));
    return;
  }

  if (process.env.MASTER_LIVE_ENABLED !== 'true') {
    process.env.MASTER_LIVE_ENABLED = 'true';
    report.note = 'temporarily set MASTER_LIVE_ENABLED for smoke';
  }

  const resolved = await resolveBrokerFromEnv();
  report.broker = resolved.broker.name;
  report.mode = resolved.mode;
  report.detail = resolved.detail;

  if (resolved.broker.name !== 'CAPITAL' || resolved.mode !== 'LIVE') {
    report.status = 'FAIL';
    report.reason = 'expected CAPITAL LIVE broker';
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 1;
    return;
  }

  const quote = await resolved.broker.getQuote(process.env.MASTER_EPIC || GOLD_SPEC.epic);
  const acct = await resolved.broker.getAccount();
  const positions = await resolved.broker.listOpenPositions();
  report.quote = quote
    ? { bid: quote.bid, ask: quote.ask, mid: quote.mid, spread: quote.spread, epic: quote.epic }
    : null;
  report.account = acct;
  report.open_positions = positions.length;
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
