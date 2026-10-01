/**
 * Snapshot Postgres (clients, brokers, codes) into data/backups/
 * Safe to run on every VS.bat start.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'backups');
const DB = process.env.DB_NAME || 'market_reader';
const USER = process.env.DB_USER || 'market_reader';
const CONTAINER = 'market-reader-postgres';

fs.mkdirSync(OUT, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const file = path.join(OUT, `clients-${stamp}.sql`);

try {
  const running = execSync(`docker inspect -f "{{.State.Running}}" ${CONTAINER}`, {
    encoding: 'utf8',
  }).trim();
  if (running !== 'true') {
    console.warn('[backup] postgres container not running — skip');
    process.exit(0);
  }
  execSync(
    `docker exec ${CONTAINER} pg_dump -U ${USER} -d ${DB} --no-owner --no-acl`,
    { stdio: ['ignore', fs.openSync(file, 'w'), 'inherit'] }
  );
  // Keep last 14 dumps
  const files = fs
    .readdirSync(OUT)
    .filter((f) => f.startsWith('clients-') && f.endsWith('.sql'))
    .sort()
    .reverse();
  for (const old of files.slice(14)) {
    fs.unlinkSync(path.join(OUT, old));
  }
  console.log(`[backup] saved ${path.relative(ROOT, file)}`);
} catch (err) {
  console.warn('[backup] failed:', err instanceof Error ? err.message : err);
  process.exit(0);
}
