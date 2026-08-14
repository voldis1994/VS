import pg from 'pg';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { setTimeout as sleep } from 'node:timers/promises';
import { config as loadEnv } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, '../../../../.env') });
loadEnv();

const { Pool } = pg;

function dbHost(): string {
  const h = (process.env.DB_HOST || '127.0.0.1').trim();
  if (!h || h.toLowerCase() === 'localhost') return '127.0.0.1';
  return h;
}

export const pool = new Pool({
  host: dbHost(),
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'market_reader',
  user: process.env.DB_USER || 'market_reader',
  password: process.env.DB_PASSWORD || 'CHANGE_ME',
  max: 20,
  connectionTimeoutMillis: 8000,
});

export function isRetryableDbError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.message} ${String(err)}` : String(err);
  return /ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|the database system is starting|connection refused/i.test(
    msg
  );
}

/** Wait until Postgres accepts connections (Docker Engine OK ≠ :5432 ready). */
export async function waitForDatabase(attempts = 30, delayMs = 2000): Promise<void> {
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query('SELECT 1');
      if (i > 1) console.log(`Postgres gatavs pēc ${i} mēģinājumiem`);
      return;
    } catch (err) {
      last = err;
      const retry = isRetryableDbError(err);
      console.warn(
        `Postgres nav gatavs (${i}/${attempts}): ${err instanceof Error ? err.message : err}`
      );
      if (!retry && i >= 3) throw err;
      await sleep(delayMs);
    }
  }
  throw last;
}

export async function healthCheck(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
