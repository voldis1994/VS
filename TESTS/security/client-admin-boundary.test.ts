import { describe, it, expect } from 'vitest';
import { authorizeClientRequest } from '../../SERVER/client-api/src/auth/authorize.ts';

describe('security: CLIENT cannot use ADMIN credentials', () => {
  it('admin header on client API → 403', () => {
    const r = authorizeClientRequest({ headers: { 'x-admin-token': 'x' } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(403);
      expect(r.code).toContain('ADMIN');
    }
  });

  it('placeholder token rejected', () => {
    const r = authorizeClientRequest({ headers: { 'x-client-token': 'CHANGE_ME' } });
    expect(r.ok).toBe(false);
  });
});
