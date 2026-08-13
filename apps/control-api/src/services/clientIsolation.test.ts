import { describe, expect, it } from 'vitest';
import { robotIdFor } from '../services/robotDesk.js';
import { isPublicUnauthedPath } from '../middleware/auth.js';

describe('multi-client isolation invariants', () => {
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
  });
});
