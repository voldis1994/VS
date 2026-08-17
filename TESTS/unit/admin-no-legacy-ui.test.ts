/**
 * Regression: production ADMIN must be native PySide6, never the old web/tactical UI.
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
    if (name === 'node_modules' || name === '__pycache__') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx|js|jsx|mjs|cjs|css|html|json|md|py|ps1|bat)$/.test(name)) acc.push(p);
  }
  return acc;
}

describe('ADMIN production path — native desktop, no legacy tactical UI', () => {
  it('ADMIN/desktop is native PySide6 VS Admin', () => {
    expect(existsSync(join(ADMIN_DESKTOP, 'main.py'))).toBe(true);
    expect(existsSync(join(ADMIN_DESKTOP, 'requirements.txt'))).toBe(true);
    const main = readFileSync(join(ADMIN_DESKTOP, 'main.py'), 'utf8');
    expect(main).toMatch(/PySide6/);
    expect(main).toMatch(/VS Admin/);
    expect(existsSync(join(ADMIN_DESKTOP, 'package.json'))).toBe(false);
    expect(existsSync(join(ADMIN_DESKTOP, 'vite.config.ts'))).toBe(false);
    expect(existsSync(join(ADMIN_DESKTOP, 'index.html'))).toBe(false);
  });

  it('production ADMIN/desktop source must not contain legacy identifiers', () => {
    const offenders: string[] = [];
    for (const file of walk(ADMIN_DESKTOP)) {
      const src = readFileSync(file, 'utf8');
      for (const marker of LEGACY_MARKERS) {
        if (src.includes(marker)) offenders.push(`${file} :: ${marker}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('START_MSI.bat launches VS Admin.exe and never a browser UI', () => {
    expect(existsSync(START_MSI)).toBe(true);
    const bat = readFileSync(START_MSI, 'utf8');
    expect(bat).toMatch(/start-admin\.ps1/);
    expect(bat).not.toMatch(/vite --host|5173|legacy-review/i);

    expect(existsSync(START_PS1)).toBe(true);
    const ps1 = readFileSync(START_PS1, 'utf8');
    expect(ps1).toContain('ADMIN/desktop');
    expect(ps1).toContain('VS Admin.exe');
    expect(ps1).not.toMatch(/5188/);
    expect(ps1).not.toContain('serve-admin.mjs');
    expect(ps1).not.toMatch(/apps\\dashboard/);
    expect(ps1).not.toMatch(/npm exec.*vite/);
    expect(ps1).not.toMatch(/Start-Process http/);
  });

  it('install-admin.ps1 builds native VS Admin.exe via BUILD_ADMIN.bat', () => {
    expect(existsSync(INSTALL_PS1)).toBe(true);
    const ps1 = readFileSync(INSTALL_PS1, 'utf8');
    expect(ps1).toContain('BUILD_ADMIN.bat');
    expect(ps1).toContain('VS Admin.exe');
    expect(ps1).not.toMatch(/@vs\/admin-desktop/);
    expect(ps1).not.toMatch(/npm run build/);
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
