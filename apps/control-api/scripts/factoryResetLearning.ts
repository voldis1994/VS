/**
 * CLI: learn-from-scratch reset (keeps Capital API + clients).
 *
 *   npx tsx scripts/factoryResetLearning.ts --yes
 *   npx tsx scripts/factoryResetLearning.ts --yes --force-open
 *   npx tsx scripts/factoryResetLearning.ts --yes --wipe-db   (only if Postgres up)
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
        `Wipes genome, learners, auto-cal, desk Soft/Peak/Target, experience (FILES).\n` +
        `DB history wipe is OFF by default (use --wipe-db when Postgres is up).\n` +
        `KEEPS: clients, Capital credentials, broker accounts, capital_markets.\n` +
        `Run: npx tsx scripts/factoryResetLearning.ts --yes`
    );
    process.exit(2);
  }
  const wipeDb = args.has('--wipe-db') || args.has('--wipe-db-history');
  // legacy flag: --keep-db-history meant "don't wipe"; default is already no wipe
  console.log(
    wipeDb
      ? '[1/2] FILE + DB wipe…'
      : '[1/2] FILE wipe only (no Postgres) — starting…'
  );
  const result = await factoryResetLearning({
    confirm: FACTORY_RESET_CONFIRM,
    wipe_db_history: wipeDb,
    force_open_trades: args.has('--force-open'),
    wipe_brain_history: !args.has('--keep-brain-history'),
  });
  console.log('[2/2] Done.');
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
