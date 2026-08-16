import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname, '../..');

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'legacy-review' || name === 'Old-system') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx|js|jsx|mjs|css|html)$/.test(name)) acc.push(p);
  }
  return acc;
}

describe('production UI must not import legacy-review', () => {
  it('scans v2 UI trees', () => {
    const roots = [
      join(ROOT, 'SERVER/dashboard-v2'),
      join(ROOT, 'ADMIN/apps/dashboard-v2'),
      join(ROOT, 'CLIENT/apps/client-v2'),
    ];
    const offenders: string[] = [];
    for (const r of roots) {
      for (const file of walk(r)) {
        const src = readFileSync(file, 'utf8');
        if (/legacy-review|Old-system\//.test(src)) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
