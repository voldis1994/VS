/**
 * CLI: learn-from-scratch reset (keeps Capital API + clients).
 *
 *   npx tsx scripts/factoryResetLearning.ts --yes
 *   npx tsx scripts/factoryResetLearning.ts --yes --force-open
 *   npx tsx scripts/factoryResetLearning.ts --yes --keep-db-history
 */
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FACTORY_RESET_CONFIRM,
  factoryResetLearning,
} from '../src/services/factoryResetLearning.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
dotenv.config({ path: path.join(ROOT, '.env') });
dotenv.config({ path: path.join(HERE, '../.env') });

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  if (!args.has('--yes') && !args.has('-y')) {
    console.error(
      `Refusing without --yes\n` +
        `This wipes genome, learners, auto-cal, desk Soft/Peak/Target, experience,\n` +
        `and (by default) trade/position/audit DB history.\n` +
        `KEEPS: clients, Capital credentials, broker accounts, capital_markets.\n` +
        `Run: npx tsx scripts/factoryResetLearning.ts --yes`
    );
    process.exit(2);
  }
  console.log('[1/2] .env loaded — starting factory reset…');
  const result = await factoryResetLearning({
    confirm: FACTORY_RESET_CONFIRM,
    wipe_db_history: !args.has('--keep-db-history'),
    force_open_trades: args.has('--force-open'),
    wipe_brain_history: !args.has('--keep-brain-history'),
  });
  console.log('[2/2] Done.');
  console.log(JSON.stringify(result, null, 2));
  // Force-exit — do not wait on stray timers / trash cleanup
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
