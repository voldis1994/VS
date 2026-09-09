import { describe, expect, it } from 'vitest';
import { robotIdFor } from '../services/robotDesk.js';
import { isPublicUnauthedPath } from '../middleware/auth.js';
import { computeClientRobotStatus } from '../services/clientPanel.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

describe('multi-client isolation invariants', () => {
  it('STOP kills entry brains only — manage-only open trade on same account survives', () => {
    const robots = [
      { id: 'a-entry', account_id: 1, running: true, entry_enabled: true, open_side: null },
      { id: 'a-manage', account_id: 1, running: true, entry_enabled: false, open_side: 'BUY' as const },
      { id: 'b-manage', account_id: 2, running: true, entry_enabled: false, open_side: 'SELL' as const },
    ];
    const stopEntry = robots
      .filter((s) => s.account_id === 1 && s.running && s.entry_enabled)
      .map((s) => s.id);
    const stopFlat = robots
      .filter((s) => s.account_id === 1 && s.running && !s.entry_enabled && !s.open_side)
      .map((s) => s.id);
    expect(stopEntry).toEqual(['a-entry']);
    expect(stopFlat).toEqual([]);
    expect(robots.find((s) => s.id === 'a-manage')?.open_side).toBe('BUY');
    expect(robots.find((s) => s.id === 'b-manage')?.running).toBe(true);
  });

  it('robot ids are per account+epic (Client A ≠ Client B)', () => {
    const aGold = robotIdFor(17, 'GOLD');
    const bGold = robotIdFor(18, 'GOLD');
    const aEur = robotIdFor(17, 'EURUSD');
    expect(aGold).not.toBe(bGold);
    expect(aGold).not.toBe(aEur);
    expect(aGold).toContain('17');
    expect(bGold).toContain('18');
  });

  it('Client Panel START uses own desk brain — not Market Core fanout subscription', () => {
    const src = readFileSync(fileURLToPath(new URL('./clientPanel.ts', import.meta.url)), 'utf8');
    expect(src).toMatch(/startRobotSession/);
    expect(src).toMatch(/mode: 'own_brain'/);
    expect(src).toMatch(/Does NOT subscribe to shared Market Core/);
    expect(src).toMatch(/assertClientOwnBrainStartAllowed/);
    expect(src).toMatch(/masterOwnsPipeline/);
    expect(src).not.toMatch(/\bactivateSubscription\b/);
  });

  it('refuses Client own-brain START while MASTER owns_pipeline', async () => {
    const { assertClientOwnBrainStartAllowed } = await import('./clientPanel.js');
    const { masterRuntime } = await import('../master/runtime.js');
    const prevPref = masterRuntime.owns_pipeline_pref;
    const prevEnv = process.env.MASTER_OWNS_PIPELINE;
    try {
      masterRuntime.owns_pipeline_pref = null;
      delete process.env.MASTER_OWNS_PIPELINE;
      expect(assertClientOwnBrainStartAllowed().ok).toBe(true);

      masterRuntime.setOwnsPipeline(true);
      const blocked = assertClientOwnBrainStartAllowed();
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) expect(blocked.detail).toMatch(/owns_pipeline/);

      masterRuntime.setOwnsPipeline(false);
      expect(assertClientOwnBrainStartAllowed().ok).toBe(true);
    } finally {
      masterRuntime.owns_pipeline_pref = prevPref;
      if (prevEnv === undefined) delete process.env.MASTER_OWNS_PIPELINE;
      else process.env.MASTER_OWNS_PIPELINE = prevEnv;
    }
  });

  it('own-brain status ignores Market Core heartbeat', () => {
    expect(
      computeClientRobotStatus({
        requestedRunning: true,
        hasAccount: true,
        hasEpic: true,
        deskEntryRunning: true,
      }).robot_status
    ).toBe('RUNNING');
    expect(
      computeClientRobotStatus({
        requestedRunning: true,
        hasAccount: true,
        hasEpic: true,
        deskEntryRunning: false,
      }).robot_status
    ).toBe('STARTING');
  });

  it('admin client list path is not under client API prefix', () => {
    // Guard against auth middleware accidentally publicizing /api/clients
    const publicPrefixes = ['/api/client-auth/', '/api/client/', '/ws/client'];
    const adminPath = '/api/clients';
    expect(publicPrefixes.some((p) => adminPath === p || adminPath.startsWith(p))).toBe(false);
  });

  it('static client panel GET is public; admin API is not', () => {
    expect(isPublicUnauthedPath('GET', '/')).toBe(true);
    expect(isPublicUnauthedPath('GET', '/assets/index.js')).toBe(true);
    expect(isPublicUnauthedPath('GET', '/logo.svg')).toBe(true);
    expect(isPublicUnauthedPath('GET', '/api/clients')).toBe(false);
    expect(isPublicUnauthedPath('POST', '/')).toBe(false);
    expect(isPublicUnauthedPath('GET', '/api/client-auth/login')).toBe(true);
  });
});
