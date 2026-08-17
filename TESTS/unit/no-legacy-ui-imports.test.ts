import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname, '../..');

function walk(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'legacy-review' || name === 'old version') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx|js|jsx|mjs|css|html)$/.test(name)) acc.push(p);
  }
  return acc;
}

const PROD_ROOTS = [
  join(ROOT, 'SERVER/control-api/src'),
  join(ROOT, 'SERVER/client-gateway'),
  join(ROOT, 'SERVER/core'),
  join(ROOT, 'SERVER/monitor'),
  join(ROOT, 'ADMIN/desktop'),
  join(ROOT, 'ADMIN/tests'),
  join(ROOT, 'CLIENT/web'),
  join(ROOT, 'SHARED'),
];

describe('production must not import legacy-review', () => {
  it('scans production source trees', () => {
    const offenders: string[] = [];
    for (const r of PROD_ROOTS) {
      for (const file of walk(r)) {
        const src = readFileSync(file, 'utf8');
        if (/legacy-review\/|Old-system\/|old version\//.test(src)) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('legacy-review directory is not required at runtime', () => {
    // Presence of archive is OK; production entrypoints must not live there.
    expect(existsSync(join(ROOT, 'SERVER/control-api'))).toBe(true);
    expect(existsSync(join(ROOT, 'ADMIN/desktop'))).toBe(true);
    expect(existsSync(join(ROOT, 'CLIENT/web'))).toBe(true);
  });
});
