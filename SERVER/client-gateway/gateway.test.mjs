import { describe, expect, it } from 'vitest';
import { isClientPublicPath } from './gateway.mjs';

describe('client gateway path policy', () => {
  it('allows client auth, panel, websocket, health, and static', () => {
    expect(isClientPublicPath('/api/client-auth/login')).toBe(true);
    expect(isClientPublicPath('/api/client/start')).toBe(true);
    expect(isClientPublicPath('/api/client/positions')).toBe(true);
    expect(isClientPublicPath('/ws/client')).toBe(true);
    expect(isClientPublicPath('/health')).toBe(true);
    expect(isClientPublicPath('/')).toBe(true);
    expect(isClientPublicPath('/assets/index.js')).toBe(true);
  });

  it('blocks admin and internal APIs', () => {
    expect(isClientPublicPath('/api/v1/admin/snapshot')).toBe(false);
    expect(isClientPublicPath('/api/v1/admin/lan-bootstrap')).toBe(false);
    expect(isClientPublicPath('/api/clients')).toBe(false);
    expect(isClientPublicPath('/api/system/mode')).toBe(false);
    expect(isClientPublicPath('/api/system/status')).toBe(false);
    expect(isClientPublicPath('/api/v1/server/monitor')).toBe(false);
    expect(isClientPublicPath('/api/pipeline/heartbeat')).toBe(false);
    expect(isClientPublicPath('/ws')).toBe(false);
    expect(isClientPublicPath('/api/brokers')).toBe(false);
    expect(isClientPublicPath('/admin')).toBe(false);
    expect(isClientPublicPath('/admin/')).toBe(false);
    expect(isClientPublicPath('/admin/app.js')).toBe(false);
  });
});
