import { describe, expect, it } from 'vitest';
import { isPublicUnauthedPath } from '../middleware/auth.js';

describe('auth public monitor console', () => {
  it('allows localhost console monitor paths without admin token', () => {
    expect(isPublicUnauthedPath('GET', '/api/v1/server/monitor/console')).toBe(true);
    expect(isPublicUnauthedPath('GET', '/api/v1/server/monitor/console/text')).toBe(true);
    expect(isPublicUnauthedPath('GET', '/api/v1/server/monitor/console?x=1')).toBe(true);
  });

  it('does not open the authenticated monitor path', () => {
    expect(isPublicUnauthedPath('GET', '/api/v1/server/monitor')).toBe(false);
    expect(isPublicUnauthedPath('GET', '/api/v1/server/monitor/text')).toBe(false);
    expect(isPublicUnauthedPath('GET', '/api/v1/admin/snapshot')).toBe(false);
  });

  it('does not expose system mode/status without auth', () => {
    expect(isPublicUnauthedPath('GET', '/api/system/mode')).toBe(false);
    expect(isPublicUnauthedPath('POST', '/api/system/mode')).toBe(false);
    expect(isPublicUnauthedPath('GET', '/api/system/status')).toBe(false);
  });

  it('allows LAN bootstrap path (handler still enforces VS_LAN_TRUST_ADMIN)', () => {
    expect(isPublicUnauthedPath('GET', '/api/v1/admin/lan-bootstrap')).toBe(true);
  });
});
