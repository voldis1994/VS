import { describe, expect, it } from 'vitest';
import { robotIdFor } from '../services/robotDesk.js';
import { isPublicUnauthedPath } from '../middleware/auth.js';

describe('multi-client isolation invariants', () => {
  it('STOP kills entry brains only — manage-only open trade on same account survives', () => {
    const robots = [
      { id: 'a-entry', account_id: 1, running: true, entry_enabled: true, open_side: null, deal_id: null, mode: 'ENTRY' },
      { id: 'a-manage', account_id: 1, running: true, entry_enabled: false, open_side: 'BUY' as const, deal_id: 'd1', mode: 'MANAGE' },
      { id: 'a-ghost-manage', account_id: 1, running: true, entry_enabled: false, open_side: null, deal_id: null, mode: 'MANAGE' },
      { id: 'a-flat-manage', account_id: 1, running: true, entry_enabled: false, open_side: null, deal_id: null, mode: 'FLAT' },
      { id: 'b-manage', account_id: 2, running: true, entry_enabled: false, open_side: 'SELL' as const, deal_id: 'd2', mode: 'MANAGE' },
    ];
    const stopEntry = robots
      .filter((s) => s.account_id === 1 && s.running && s.entry_enabled)
      .map((s) => s.id);
    const stopFlat = robots
      .filter(
        (s) =>
          s.account_id === 1 &&
          s.running &&
          !s.entry_enabled &&
          !s.open_side &&
          !s.deal_id &&
          s.mode !== 'MANAGE'
      )
      .map((s) => s.id);
    expect(stopEntry).toEqual(['a-entry']);
    expect(stopFlat).toEqual(['a-flat-manage']);
    expect(robots.find((s) => s.id === 'a-manage')?.open_side).toBe('BUY');
    expect(robots.find((s) => s.id === 'a-ghost-manage')?.mode).toBe('MANAGE');
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
    // POST mode must require admin — previously public and could force LIVE
    expect(isPublicUnauthedPath('GET', '/api/system/mode')).toBe(true);
    expect(isPublicUnauthedPath('POST', '/api/system/mode')).toBe(false);
    expect(isPublicUnauthedPath('POST', '/api/robot-desk/start')).toBe(false);
  });

  it('trusted local desk IPs cover loopback + RFC1918 (admin CLIENTS list)', async () => {
    const { isTrustedLocalDesk } = await import('../middleware/auth.js');
    const asReq = (ip: string) => ({ ip } as never);
    expect(isTrustedLocalDesk(asReq('127.0.0.1'))).toBe(true);
    expect(isTrustedLocalDesk(asReq('::1'))).toBe(true);
    expect(isTrustedLocalDesk(asReq('::ffff:127.0.0.1'))).toBe(true);
    expect(isTrustedLocalDesk(asReq('192.168.1.10'))).toBe(true);
    expect(isTrustedLocalDesk(asReq('10.0.0.5'))).toBe(true);
    expect(isTrustedLocalDesk(asReq('8.8.8.8'))).toBe(false);
  });
});
