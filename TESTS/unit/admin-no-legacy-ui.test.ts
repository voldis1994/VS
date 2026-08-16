/**
 * Regression: production ADMIN must NEVER contain or launch the old tactical UI.
 * Fails the build/test suite if TACTICAL DESK / ROBOT BRAIN / DRIFT GUARD appear
 * under ADMIN/desktop (source or dist), or if START_ADMIN.bat does not resolve
 * exclusively to ADMIN/desktop.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname, '../..');
const ADMIN_DESKTOP = join(ROOT, 'ADMIN/desktop');
const START_BAT = join(ROOT, 'ADMIN/START_ADMIN.bat');
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
      // Extra hard fails for classic tactical chrome
      if (/\bTACTICAL DESK\b/i.test(src)) offenders.push(`${file} :: TACTICAL DESK`);
      if (/\bROBOT BRAIN\b/i.test(src)) offenders.push(`${file} :: ROBOT BRAIN`);
      if (/\bDRIFT GUARD\b/i.test(src)) offenders.push(`${file} :: DRIFT GUARD`);
    }
    expect(offenders).toEqual([]);
  });

  it('START_ADMIN.bat resolves only to ADMIN/desktop (never legacy-review / :5173 as product)', () => {
    expect(existsSync(START_BAT)).toBe(true);
    const bat = readFileSync(START_BAT, 'utf8');
    expect(bat).toMatch(/desktop\\package\.json|desktop\/package\.json|desktop\\/);
    expect(bat).toContain('@vs/admin-desktop');
    expect(bat).toContain('VS ADMIN');
    expect(bat).toMatch(/start-admin\.ps1/);
    // Mentions of legacy-review only allowed as explicit refusals in comments
    expect(bat).not.toMatch(/call.*legacy-review|cd.*legacy-review|apps\\dashboard|apps\/dashboard/i);

    expect(existsSync(START_PS1)).toBe(true);
    const ps1 = readFileSync(START_PS1, 'utf8');
    expect(ps1).toContain('ADMIN/desktop');
    expect(ps1).toMatch(/\$UiPort\s*=\s*5188/);
    expect(ps1).toContain('@vs/admin-desktop');
    expect(ps1).toMatch(/strictPort/);
    expect(ps1).not.toMatch(/apps\\dashboard/);
    // Must kill stale tactical port, must not serve product on 5173
    expect(ps1).toMatch(/Stop-PortListeners\s+5173|5173/);
    expect(ps1).toMatch(/--port".*5188|UiPort.*5188|"\$UiPort"/);
  });

  it('install-admin.ps1 installs only ADMIN/desktop and refuses legacy markers', () => {
    expect(existsSync(INSTALL_PS1)).toBe(true);
    const ps1 = readFileSync(INSTALL_PS1, 'utf8');
    expect(ps1).toContain('@vs/admin-desktop');
    expect(ps1).toContain('ADMIN/desktop');
    expect(ps1).toMatch(/TACTICAL DESK|LegacyMarkers|legacy marker/i);
    expect(ps1).toMatch(/npm run build|run build/);
    // Must not npm-install or start apps/dashboard as the product
    expect(ps1).not.toMatch(/Push-Location.*apps\\dashboard|cd .*apps\\dashboard/i);
  });

  it('1_START_WINDOWS.bat redirects to START_ADMIN.bat only', () => {
    const bat = readFileSync(join(ROOT, 'ADMIN/1_START_WINDOWS.bat'), 'utf8');
    expect(bat).toContain('START_ADMIN.bat');
    expect(bat).not.toMatch(/tsx|startAdmin\.ts|5173|legacy-review/i);
  });

  it('legacy tactical strings exist only under legacy-review (archive proof)', () => {
    const logo = join(ROOT, 'legacy-review/apps/dashboard/src/components/Logo.tsx');
    expect(existsSync(logo)).toBe(true);
    const src = readFileSync(logo, 'utf8');
    expect(src).toContain('VS SYSTEM');
    expect(src).toContain('TACTICAL DESK');
  });
});
