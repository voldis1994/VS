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
const BUILD_BAT = join(ROOT, 'ADMIN/windows/BUILD_ADMIN.bat');

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

describe('ADMIN production path — web control panel on one MSI, no tactical UI', () => {
  it('ADMIN/desk is the PALAID TACTICAL DESK with SAFETY SL', () => {
    const logo = readFileSync(join(ROOT, 'ADMIN/desk/src/components/Logo.tsx'), 'utf8');
    const robot = readFileSync(join(ROOT, 'ADMIN/desk/src/pages/RobotDeskPage.tsx'), 'utf8');
    expect(logo).toContain('TACTICAL DESK');
    expect(robot).toMatch(/SAFETY SL/);
    expect(robot).toMatch(/ROBOT COMMAND/);
    const clients = readFileSync(join(ROOT, 'ADMIN/desk/src/pages/ClientsPage.tsx'), 'utf8');
    expect(clients).toMatch(/handleRename/);
    expect(clients).toContain("JSON.stringify({ name: next })");
    expect(clients).toContain("JSON.stringify({ name, password })");
    expect(clients).toContain('Set password');
    expect(clients).toContain('8443');
    expect(clients).toContain('client-url.txt');
    expect(clients).toContain('Never type');
    expect(clients).not.toMatch(/trycloudflare\.com/);
    expect(robot).toMatch(/MARKET CLOSED/);
    expect(robot).toMatch(/last_close_at/);
    expect(existsSync(join(ROOT, 'ADMIN/desk/src/pages/FeedsPage.tsx'))).toBe(true);
    expect(existsSync(join(ROOT, 'ADMIN/desk/src/pages/OrbitReaderPage.tsx'))).toBe(true);
  });

  it('ADMIN/web control panel exists and desktop archive is not the start path', () => {
    expect(existsSync(join(ROOT, 'ADMIN/web/index.html'))).toBe(true);
    expect(existsSync(join(ROOT, 'ADMIN/web/app.js'))).toBe(true);
    expect(existsSync(join(ROOT, 'SERVER/calc/vs-calc.cpp'))).toBe(true);
    const html = readFileSync(join(ROOT, 'ADMIN/web/index.html'), 'utf8');
    expect(html).toMatch(/VS ADMIN/);
    expect(html).not.toMatch(/ROBOT BRAIN/);
  });

  it('production ADMIN web + desktop must not contain legacy identifiers', () => {
    const offenders: string[] = [];
    for (const dir of [ADMIN_DESKTOP, join(ROOT, 'ADMIN/web')]) {
      for (const file of walk(dir)) {
        const src = readFileSync(file, 'utf8');
        for (const marker of LEGACY_MARKERS) {
          if (src.includes(marker)) offenders.push(`${file} :: ${marker}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('START_MSI.bat opens TACTICAL DESK /robot and never Vite 5188', () => {
    expect(existsSync(START_MSI)).toBe(true);
    const bat = readFileSync(START_MSI, 'utf8');
    expect(bat).toMatch(/start-admin\.ps1/);
    expect(bat).not.toMatch(/vite --host|5173|legacy-review/i);

    expect(existsSync(START_PS1)).toBe(true);
    const ps1 = readFileSync(START_PS1, 'utf8');
    expect(ps1).toContain('3000/robot');
    expect(ps1).toContain('8443');
    expect(ps1).not.toMatch(/trycloudflare\.com/);
    expect(ps1).not.toMatch(/cloudflared/);
    expect(ps1).toContain('VS_SINGLE_BOX');
    expect(ps1).toContain('vs-calc');
    expect(ps1).toContain('TACTICAL DESK');
    expect(ps1).toMatch(/Restarting Control API so \/robot is TACTICAL DESK/);
    expect(ps1).toContain('PHONE');
    expect(ps1).toContain('NOT 127.0.0.1');
    expect(ps1).toContain('VS CLIENT 8443');
    expect(ps1).toMatch(/never overwrites this/);
    expect(ps1).not.toMatch(/\$panelAlreadyUp/);
    expect(ps1).toContain('TACTICAL DESK missing ADMIN\\desk\\dist\\index.html');
    expect(ps1).toContain('Remove-Item -Recurse -Force $deskDist');
    expect(ps1).not.toMatch(/5188/);
    expect(ps1).not.toContain('serve-admin.mjs');
    expect(ps1).not.toMatch(/apps\\dashboard/);
    expect(ps1).not.toMatch(/npm exec.*vite/);
    expect(ps1).toMatch(/node_modules\\vite\\bin\\vite\.js/);
    expect(ps1).toMatch(/Remove-Item Env:NODE_ENV/);
    expect(ps1).toMatch(/@\("down", "-v"\)/);
    expect(existsSync(join(ROOT, 'PALAID.bat'))).toBe(true);
  });

  it('ADMIN web forms are static HTML and poll must not wipe inputs', () => {
    const html = readFileSync(join(ROOT, 'ADMIN/web/index.html'), 'utf8');
    const js = readFileSync(join(ROOT, 'ADMIN/web/app.js'), 'utf8');
    expect(html).toMatch(/id="bkey"/);
    expect(html).toMatch(/id="bpass"/);
    expect(html).toMatch(/id="bident"/);
    expect(html).toMatch(/class="pane"/);
    expect(js).toMatch(/typingInForm/);
    expect(js).not.toMatch(/getElementById\('view'\)\.innerHTML/);
    expect(js).not.toMatch(/function el\(html\)/);
    expect(js).not.toMatch(/function render\(/);
  });

  it('BUILD_ADMIN.bat is the only canonical Windows build', () => {
    expect(existsSync(BUILD_BAT)).toBe(true);
    const bat = readFileSync(BUILD_BAT, 'utf8');
    expect(bat).toMatch(/PyInstaller|pyinstaller/i);
    expect(bat).toContain('VS Admin');
    expect(existsSync(join(ROOT, 'ADMIN/windows/BUILD_ADMIN_NEW.bat'))).toBe(false);
    expect(existsSync(join(ROOT, 'ADMIN/windows/install-admin.ps1'))).toBe(false);
    expect(existsSync(join(ROOT, 'ADMIN/INSTALL_ADMIN.bat'))).toBe(false);
    expect(existsSync(join(ROOT, 'CLIENT/windows'))).toBe(false);
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
