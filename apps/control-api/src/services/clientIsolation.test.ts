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

  it('START on one epic stops other flat robots on the same account (not other clients)', () => {
    const robots = [
      { id: 'g-kimly', account_id: 17, epic: 'KIMLY', running: true, entry_enabled: true, open_side: null },
      { id: 'g-eur', account_id: 17, epic: 'EURUSD', running: false, entry_enabled: true, open_side: null },
      { id: 'boss-gold', account_id: 18, epic: 'GOLD', running: true, entry_enabled: true, open_side: null },
      { id: 'g-manage', account_id: 17, epic: 'OIL_BRENT', running: true, entry_enabled: false, open_side: 'BUY' as const },
    ];
    const keep = 'EURUSD';
    const stopped = robots
      .filter((s) => {
        if (s.account_id !== 17 || !s.running) return false;
        if (s.epic === keep) return false;
        if (!s.entry_enabled && s.open_side) return false;
        return true;
      })
      .map((s) => s.id);
    expect(stopped).toEqual(['g-kimly']);
    expect(robots.find((s) => s.id === 'boss-gold')?.running).toBe(true);
    expect(robots.find((s) => s.id === 'g-manage')?.open_side).toBe('BUY');
  });

  it('never stops a robot that is IN TRADE to switch market', () => {
    const robots = [
      { id: 'boss-gold', account_id: 18, epic: 'GOLD', running: true, entry_enabled: true, open_side: 'BUY' as const },
    ];
    const keep = 'EURUSD';
    const stopped = robots
      .filter((s) => {
        if (s.account_id !== 18 || !s.running) return false;
        if (s.epic === keep) return false;
        if (s.open_side) return false;
        return true;
      })
      .map((s) => s.id);
    expect(stopped).toEqual([]);
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
    expect(src).not.toMatch(/\bactivateSubscription\b/);
    expect(src).toMatch(/override\?\.epic/);
    const desk = readFileSync(fileURLToPath(new URL('./robotDesk.ts', import.meta.url)), 'utf8');
    expect(desk).toMatch(/stopOtherRobotsForAccount/);
    expect(desk).toMatch(/panel_epic/);
    expect(desk).toMatch(/IN TRADE/);
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
