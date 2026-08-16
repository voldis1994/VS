/**
 * Regression: physical i3 monitor install path must not depend on sourcing
 * secret server.env, and must resolve local tsx / curl console fallback.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname, '../..');
const SERVER = join(ROOT, 'SERVER');

describe('i3 monitor installation path', () => {
  it('SHOW_LIVE_MONITOR does not source server.env secrets', () => {
    const sh = readFileSync(join(SERVER, 'SHOW_LIVE_MONITOR.sh'), 'utf8');
    expect(sh).not.toMatch(/source\s+.*server\.env/);
    expect(sh).toMatch(/MONITOR_SERVER/);
  });

  it('MONITOR_SERVER prefers /opt/vs-server and never requires global tsx', () => {
    const sh = readFileSync(join(SERVER, 'MONITOR_SERVER'), 'utf8');
    expect(sh).toContain('/opt/vs-server/control-api');
    expect(sh).toContain('node_modules/.bin/tsx');
    expect(sh).toContain('run_curl_monitor');
    expect(sh).toContain('/api/v1/server/monitor/console/text');
    expect(sh).not.toMatch(/npx\s+tsx/);
    // Must not hard-fail with only "tsx missing" when curl fallback exists
    expect(sh).not.toMatch(/FAIL: tsx missing/);
  });

  it('INSTALL_I3_SERVER installs vs-monitor and hard-fails without tsx', () => {
    const sh = readFileSync(join(SERVER, 'INSTALL_I3_SERVER'), 'utf8');
    expect(sh).toContain('/usr/local/bin/vs-monitor');
    expect(sh).toContain('INSTALL SELF-TEST');
    expect(sh).toContain('monitor console endpoint');
    expect(sh).toMatch(/npm ci \|\| npm install/);
    expect(sh).toContain('tsx not installed');
    expect(existsSync(join(SERVER, 'install/INSTALL_I3_SERVER.sh'))).toBe(true);
    expect(existsSync(join(SERVER, 'deploy/vs-monitor'))).toBe(true);
  });

  it('server.env permissions stay restricted (no 777)', () => {
    const sh = readFileSync(join(SERVER, 'INSTALL_I3_SERVER'), 'utf8');
    expect(sh).toMatch(/chmod 640 "\$SERVER_ENV"/);
    expect(sh).not.toMatch(/chmod 777.*server\.env/);
    expect(sh).toContain('secrets protected');
  });

  it('control-api package lists tsx as production dependency', () => {
    const pkg = JSON.parse(readFileSync(join(SERVER, 'control-api/package.json'), 'utf8'));
    expect(pkg.dependencies.tsx).toBeTruthy();
    expect(pkg.scripts['vs-server:monitor']).toMatch(/tsx/);
  });

  it('vs-server-monitor unit does not require EnvironmentFile secrets', () => {
    const unit = readFileSync(join(SERVER, 'deploy/systemd/vs-server-monitor.service'), 'utf8');
    expect(unit).not.toMatch(/EnvironmentFile=.*server\.env/);
    expect(unit).toContain('VS_MONITOR_API_URL=http://127.0.0.1:3000');
    expect(unit).toContain('ExecStart=/opt/vs-server/MONITOR_SERVER');
  });
});
