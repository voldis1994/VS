/**
 * One-time: copy data from old compose project volume → vs_postgres_data
 * so clients are not lost when volume naming was stabilized.
 */
import { execSync } from 'node:child_process';

function sh(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function main() {
  const volumes = sh('docker volume ls -q')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const target = 'vs_postgres_data';
  if (volumes.includes(target)) {
    console.log(`[persist] volume ${target} already exists — OK`);
    return;
  }

  const candidates = volumes.filter(
    (v) =>
      v !== target &&
      (v.endsWith('_postgres_data') || v === 'postgres_data' || v.includes('postgres'))
  );

  // Prefer volumes that look like compose project postgres_data
  const preferred =
    candidates.find((v) => v.endsWith('_postgres_data')) ||
    candidates.find((v) => /market.?reader|vs_|workspace/i.test(v)) ||
    candidates[0];

  if (!preferred) {
    console.log(`[persist] no old postgres volume — ${target} will be created empty`);
    return;
  }

  console.log(`[persist] migrating ${preferred} → ${target}`);
  sh(`docker volume create ${target}`);
  const out = sh(
    `docker run --rm -v ${preferred}:/from -v ${target}:/to alpine sh -c "cp -a /from/. /to/ && echo OK"`
  );
  if (!out.includes('OK')) {
    console.warn('[persist] migrate copy may have failed — check Docker');
    process.exitCode = 1;
    return;
  }
  console.log(`[persist] migrated clients DB from ${preferred}`);
}

main();
