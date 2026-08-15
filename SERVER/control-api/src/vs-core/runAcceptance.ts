/**
 * CLI: write acceptance report artifacts under data/vs-core-acceptance/
 */
import { writeAcceptanceReport } from './acceptanceGate.js';
import { join } from 'path';

async function main() {
  const out =
    process.env.VS_ACCEPTANCE_OUT ||
    join(process.cwd(), '..', '..', 'data', 'vs-core-acceptance');
  const report = await writeAcceptanceReport(out);
  console.log(JSON.stringify(report.summary, null, 2));
  console.log(`previous_master_task_complete=${report.previous_master_task_complete}`);
  console.log(`live_readiness=${report.live_readiness}`);
  console.log(`wrote ${out}/acceptance-report.json`);
  if (report.summary.fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
