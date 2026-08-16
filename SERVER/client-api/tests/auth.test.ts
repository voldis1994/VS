import { describe, it, expect } from 'vitest';
import { authorizeClientRequest } from '../src/auth/authorize.ts';

describe('client-api auth boundary', () => {
  it('rejects admin token on client API', () => {
    const r = authorizeClientRequest({
      headers: { 'x-admin-token': 'secret' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it('rejects missing token', () => {
    const r = authorizeClientRequest({ headers: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  it('rejects unverified token without inventing identity', () => {
    const r = authorizeClientRequest({
      headers: { 'x-client-token': 'not-a-real-session' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SESSION_NOT_VERIFIED');
  });
});
