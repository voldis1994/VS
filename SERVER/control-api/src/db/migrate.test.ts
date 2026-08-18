import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { resolveMigrationsDir } from './migrate.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('resolveMigrationsDir', () => {
  it('reads SERVER/database/migrations even when the control-api symlink is a file', () => {
    const dir = resolveMigrationsDir(here);
    expect(statSync(dir).isDirectory()).toBe(true);
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    expect(files[0]).toBe('001_initial_schema.sql');
    expect(files).toContain('015_per_account_capital_epic.sql');
    expect(dir.replace(/\\/g, '/')).toMatch(/SERVER\/database\/migrations$/);
  });

  it('canonical folder exists as a real directory, not only a symlink', () => {
    const canonical = join(here, '../../../database/migrations');
    expect(existsSync(canonical)).toBe(true);
    expect(statSync(canonical).isDirectory()).toBe(true);
  });
});
