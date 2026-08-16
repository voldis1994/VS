import { describe, expect, it, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../db/pool.js', () => ({
  healthCheck: vi.fn(async () => true),
  pool: { query: vi.fn() },
}));

vi.mock('./robotDesk.js', () => ({
  listRobotSessions: vi.fn(() => []),
}));

describe('P6 diagnostics inject', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('injected fault surfaces component + error code + reason + timestamp + retry', async () => {
    const { _resetCapitalSessionManagerForTests } = await import('./capitalSessionManager.js');
    _resetCapitalSessionManagerForTests();
    const { injectSafeDiagnosticFault, buildSystemHealth } = await import('./systemHealth.js');
    const connId = 4242;
    injectSafeDiagnosticFault(connId, 'artificial safe test error');
    const report = await buildSystemHealth({ primaryConnectionId: connId });
    const capital = report.subsystems.find((s) => s.id === 'CAPITAL_SESSION');
    expect(capital).toBeTruthy();
    expect(capital!.name).toBe('CAPITAL SESSION');
    expect(['ERROR', 'CRITICAL', 'WARNING']).toContain(capital!.level);
    expect(capital!.error_code || capital!.code).toBeTruthy();
    expect(String(capital!.detail || capital!.broker_error)).toMatch(
      /DIAGNOSTIC_INJECT|artificial safe test error/
    );
    expect(capital!.retry_count).toBeGreaterThanOrEqual(1);
    expect(report.checked_at).toMatch(/^\d{4}-/);
    // Health payload contract (no dependency on archived desktop HTML)
    expect(report).toHaveProperty('subsystems');
    expect(Array.isArray(report.subsystems)).toBe(true);
  });
});

describe('P7 browser close does not stop engine', () => {
  it('client panel start binds Node robotDesk; stop is only explicit stopClientRobot', () => {
    const src = readFileSync(join(process.cwd(), 'src/services/clientPanel.ts'), 'utf8');
    expect(src).toContain('export async function stopClientRobot');
    expect(src).toContain('export async function startClientRobot');
    expect(src).toContain('startRobotSession');
    expect(src).not.toMatch(/beforeunload|visibilitychange|window\.close/);
  });

  it('WS disconnect path does not call stopClientRobot', () => {
    const wsDir = join(process.cwd(), 'src/ws');
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    let all = '';
    try {
      for (const f of readdirSync(wsDir)) {
        if (f.endsWith('.ts')) all += readFileSync(join(wsDir, f), 'utf8');
      }
    } catch {
      all = '';
    }
    expect(all).not.toContain('stopClientRobot');
    expect(all).not.toContain('stopRobotSession');
  });
});
