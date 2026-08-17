/**
 * Regression: production ADMIN must NEVER contain or launch the old tactical UI.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname, '../..');
const ADMIN_DESKTOP = join(ROOT, 'ADMIN/desktop');
const START_MSI = join(ROOT, 'START_MSI.bat');
const START_PS1 = join(ROOT, 'ADMIN/windows/start-admin.ps1');
const INSTALL_PS1 = join(ROOT, 'ADMIN/windows/install-admin.ps1');

const LEGACY_MARKERS = ['TACTICAL DESK', 'ROBOT BRAIN', 'DRIFT GUARD', 'VS SYSTEM //'];

function walk(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx|js|jsx|mjs|cjs|css|html|json|md)$/.test(name)) acc.push(p);
  }
  return acc;
}

describe('ADMIN production path — no legacy tactical UI', () => {
  it('ADMIN/desktop exists and is @vs/admin-desktop with VS ADMIN title', () => {
    expect(existsSync(join(ADMIN_DESKTOP, 'package.json'))).toBe(true);
    const pkg = readFileSync(join(ADMIN_DESKTOP, 'package.json'), 'utf8');
    expect(pkg).toMatch(/"name"\s*:\s*"@vs\/admin-desktop"/);
    const html = readFileSync(join(ADMIN_DESKTOP, 'index.html'), 'utf8');
    expect(html).toContain('<title>VS ADMIN</title>');
    expect(html).not.toMatch(/TACTICAL|VS SYSTEM/i);
  });

  it('production ADMIN/desktop source+dist must not contain legacy identifiers', () => {
    const offenders: string[] = [];
    for (const file of walk(ADMIN_DESKTOP)) {
      if (file.includes(`${join('public', 'runtime-config.js')}`)) continue;
      const src = readFileSync(file, 'utf8');
      for (const marker of LEGACY_MARKERS) {
        if (src.includes(marker)) offenders.push(`${file} :: ${marker}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('START_MSI.bat is the operator entry and serves dist on 5188', () => {
    expect(existsSync(START_MSI)).toBe(true);
    const bat = readFileSync(START_MSI, 'utf8');
    expect(bat).toMatch(/start-admin\.ps1/);
    expect(bat).not.toMatch(/vite --host|5173|legacy-review/i);

    expect(existsSync(START_PS1)).toBe(true);
    const ps1 = readFileSync(START_PS1, 'utf8');
    expect(ps1).toContain('ADMIN/desktop');
    expect(ps1).toMatch(/\$UiPort\s*=\s*5188/);
    expect(ps1).toContain('serve-admin.mjs');
    expect(ps1).not.toMatch(/apps\\dashboard/);
    expect(ps1).not.toMatch(/npm exec.*vite/);
  });

  it('install-admin.ps1 installs only ADMIN/desktop and refuses legacy markers', () => {
    expect(existsSync(INSTALL_PS1)).toBe(true);
    const ps1 = readFileSync(INSTALL_PS1, 'utf8');
    expect(ps1).toContain('@vs/admin-desktop');
    expect(ps1).toContain('ADMIN/desktop');
    expect(ps1).toMatch(/TACTICAL DESK|LegacyMarkers|legacy marker/i);
    expect(ps1).toMatch(/npm run build|run build/);
    expect(ps1).not.toMatch(/Push-Location.*apps\\dashboard|cd .*apps\\dashboard/i);
  });

  it('legacy tactical strings exist only under old version archive', () => {
    const logo = join(
      ROOT,
      'old version/architecture/legacy-review/apps/dashboard/src/components/Logo.tsx'
    );
    expect(existsSync(logo)).toBe(true);
    const src = readFileSync(logo, 'utf8');
    expect(src).toContain('VS SYSTEM');
    expect(src).toContain('TACTICAL DESK');
  });
});
