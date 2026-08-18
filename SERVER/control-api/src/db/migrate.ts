import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config as loadEnv } from 'dotenv';
import { pool, waitForDatabase } from './pool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, '../../../../.env') });
loadEnv();

function isSqlDir(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    // Windows Git checkout of a symlink is a file → ENOTDIR
    return false;
  }
}

/**
 * Canonical SQL lives in SERVER/database/migrations.
 * control-api/src/db/migrations is a Linux symlink; on Windows Git it becomes a file
 * and readdirSync throws ENOTDIR.
 */
export function resolveMigrationsDir(fromDir: string = __dirname): string {
  const candidates = [
    join(fromDir, '../../../database/migrations'),
    join(fromDir, 'migrations'),
  ];
  for (const dir of candidates) {
    if (isSqlDir(dir)) return dir;
  }
  throw new Error(
    'MIGRATIONS_DIR_MISSING: expected SERVER/database/migrations (Windows Git does not materialize the control-api symlink as a folder)'
  );
}

export async function runMigrations(): Promise<void> {
  await waitForDatabase();

  const migrationsDir = resolveMigrationsDir();
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  for (const file of files) {
    const { rows } = await pool.query(
      'SELECT 1 FROM schema_migrations WHERE filename = $1',
      [file]
    );
    if (rows.length > 0) continue;

    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1)',
        [file]
      );
      await client.query('COMMIT');
      console.log(`Applied migration: ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => {
      console.log('Migrations complete');
      return pool.end();
    })
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
