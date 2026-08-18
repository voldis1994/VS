import { describe, it, expect } from 'vitest';
import { isClientPublicPath } from '../../SERVER/client-gateway/gateway.mjs';

describe('security: CLIENT gateway cannot reach ADMIN APIs', () => {
  it('admin and system paths are forbidden on the public door', () => {
    expect(isClientPublicPath('/api/v1/admin/snapshot')).toBe(false);
    expect(isClientPublicPath('/api/v1/admin/lan-bootstrap')).toBe(false);
    expect(isClientPublicPath('/api/clients')).toBe(false);
    expect(isClientPublicPath('/api/system/mode')).toBe(false);
    expect(isClientPublicPath('/robot')).toBe(false);
  });

  it('client session paths remain available', () => {
    expect(isClientPublicPath('/api/client-auth/login')).toBe(true);
    expect(isClientPublicPath('/api/client/start')).toBe(true);
    expect(isClientPublicPath('/api/client/stop')).toBe(true);
  });
});
