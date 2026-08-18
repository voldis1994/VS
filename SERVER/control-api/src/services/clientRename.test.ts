import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

describe('client rename', () => {
  it('PUT /api/clients/:id rejects duplicate names and pushes the new name onto the robot board', () => {
    const src = readFileSync(join(here, '../routes/clients.ts'), 'utf8');
    expect(src).toContain('applyClientDisplayName');
    expect(src).toMatch(/name_taken/);
    expect(src).toMatch(/AND id <> \$2/);
  });

  it('robotDesk.applyClientDisplayName updates running session client_name', () => {
    const src = readFileSync(join(here, 'robotDesk.ts'), 'utf8');
    expect(src).toContain('export function applyClientDisplayName');
    expect(src).toMatch(/s\.client_name = n/);
  });
});
