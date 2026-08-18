import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'robotDesk.ts'), 'utf8');

describe('robotDesk reads Capital CLOSE', () => {
  it('syncs broker positions before parking a closed market', () => {
    const listAt = src.indexOf('const listed = await listCapitalOpenPositions(opened.session)');
    const parkAt = src.indexOf('if (!marketOpen)');
    expect(listAt).toBeGreaterThan(0);
    expect(parkAt).toBeGreaterThan(listAt);
  });

  it('keeps last close on the public session for the desk DEAL row', () => {
    expect(src).toContain('last_close_at');
    expect(src).toContain('last_close_detail');
    expect(src).toContain('POSITION_CLOSED');
    expect(src).toMatch(/MARKET CLOSED/);
  });

  it('does not freeze CLIENT dist logic here — action is MARKET CLOSED not SCAN ENTRY', () => {
    expect(src).toMatch(/HOLD \$\{s\.open_side\} · MARKET CLOSED/);
    expect(src).toContain("action = s.open_side ? `HOLD ${s.open_side} · MARKET CLOSED` : 'MARKET CLOSED'");
  });
});
