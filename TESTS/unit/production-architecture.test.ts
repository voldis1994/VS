/**
 * Production architecture invariants after desktop UI correction.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname, '../..');

function walk(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'old version') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

describe('canonical production architecture', () => {
  it('root has START_I3 and START_MSI.bat only as operator starts', () => {
    expect(existsSync(join(ROOT, 'START_I3'))).toBe(true);
    expect(existsSync(join(ROOT, 'START_MSI.bat'))).toBe(true);
    expect(existsSync(join(ROOT, 'START_I3.sh'))).toBe(false);
    expect(existsSync(join(ROOT, 'FORCE_I3_LAN'))).toBe(false);
    expect(existsSync(join(ROOT, 'legacy-review'))).toBe(false);
    expect(existsSync(join(ROOT, 'DEPLOY'))).toBe(false);
  });

  it('production source does not reference old version/', () => {
    const roots = ['SERVER', 'ADMIN', 'CLIENT', 'SHARED'];
    const offenders: string[] = [];
    for (const r of roots) {
      for (const file of walk(join(ROOT, r))) {
        if (!/\.(ts|tsx|js|mjs|ps1|bat|sh|css|html|md)$/.test(file)) continue;
        const src = readFileSync(file, 'utf8');
        if (/old version\//.test(src) && !file.includes('production-architecture.test')) {
          offenders.push(file);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('START_MSI starts one-PC web panel + C++ calc, not Vite 5188', () => {
    const msi = readFileSync(join(ROOT, 'START_MSI.bat'), 'utf8');
    expect(msi).toMatch(/start-admin\.ps1/);
    expect(msi).toMatch(/ADMIN\\web\\index.html/);
    const ps1 = readFileSync(join(ROOT, 'ADMIN/windows/start-admin.ps1'), 'utf8');
    expect(ps1).toContain('3000/admin');
    expect(ps1).toContain('VS_SINGLE_BOX');
    expect(ps1).toContain('vs-calc');
    expect(ps1).not.toMatch(/serve-admin\.mjs/);
    expect(ps1).not.toMatch(/npm exec.*vite|vite --host/);
    expect(ps1).not.toMatch(/5188/);
    expect(ps1).not.toMatch(/5173/);
    expect(existsSync(join(ROOT, 'ADMIN/web/index.html'))).toBe(true);
    expect(existsSync(join(ROOT, 'SERVER/calc/vs-calc.cpp'))).toBe(true);
    expect(existsSync(join(ROOT, 'ADMIN/runtime/serve-admin.mjs'))).toBe(false);
    expect(existsSync(join(ROOT, 'PALAID.bat'))).toBe(true);
  });

  it('client gateway exists and blocks admin paths', () => {
    expect(existsSync(join(ROOT, 'SERVER/client-gateway/gateway.mjs'))).toBe(true);
    const gw = readFileSync(join(ROOT, 'SERVER/client-gateway/gateway.mjs'), 'utf8');
    expect(gw).toMatch(/443/);
    expect(gw).toMatch(/CLIENT_FORBIDDEN_ADMIN|isClientPublicPath/);
  });

  it('firewall does not publish postgres/redis or open :3000 to the world', () => {
    const fw = readFileSync(join(ROOT, 'SERVER/network/APPLY_FIREWALL'), 'utf8');
    expect(fw).toMatch(/443/);
    expect(fw).toMatch(/192\.168\.0\.0\/16/);
    expect(fw).toMatch(/5432/);
    expect(fw).not.toMatch(/ufw allow "\$\{API_PORT\}\/tcp"/);
  });

  it('production ADMIN and Control API do not listen on 5188/5173', () => {
    const prodFiles = [
      join(ROOT, 'START_MSI.bat'),
      join(ROOT, 'ADMIN/windows/start-admin.ps1'),
      join(ROOT, 'ADMIN/windows/stop-admin.ps1'),
      join(ROOT, 'ADMIN/windows/BUILD_ADMIN.bat'),
      join(ROOT, 'SERVER/control-api/src/index.ts'),
      join(ROOT, 'SERVER/INSTALL_I3_SERVER'),
      join(ROOT, '.env.example'),
    ];
    for (const f of prodFiles) {
      const src = readFileSync(f, 'utf8');
      expect(src).not.toMatch(/:\s*5188|port 5188|UiPort\s*=\s*5188/i);
      expect(src).not.toMatch(/:\s*5173|port 5173/i);
    }
  });

  it('CLIENT web app exists and ADMIN web control panel is served from Control API', () => {
    expect(existsSync(join(ROOT, 'CLIENT/web/package.json'))).toBe(true);
    expect(existsSync(join(ROOT, 'ADMIN/web/index.html'))).toBe(true);
    expect(existsSync(join(ROOT, 'ADMIN/desktop/vite.config.ts'))).toBe(false);
  });

  it('operator BAT clutter is not in production', () => {
    expect(existsSync(join(ROOT, 'ADMIN/INSTALL_ADMIN.bat'))).toBe(false);
    expect(existsSync(join(ROOT, 'ADMIN/START_ADMIN.bat'))).toBe(false);
    expect(existsSync(join(ROOT, 'ADMIN/windows/BUILD_ADMIN_NEW.bat'))).toBe(false);
    expect(existsSync(join(ROOT, 'CLIENT/INSTALL_CLIENT.bat'))).toBe(false);
    expect(existsSync(join(ROOT, 'CLIENT/windows'))).toBe(false);
    expect(existsSync(join(ROOT, 'ADMIN/runtime/serve-admin.mjs'))).toBe(false);
  });
});
