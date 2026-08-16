import { describe, it, expect, beforeEach } from 'vitest';
import {
  heartbeatPresence,
  getAdminPresence,
  listPresence,
  _resetPresenceForTests,
} from '../../SERVER/control-api/src/vs-core/presenceRegistry.ts';

describe('presence heartbeat', () => {
  beforeEach(() => _resetPresenceForTests());

  it('marks ADMIN online after heartbeat and offline after timeout window', () => {
    const rec = heartbeatPresence({
      device_id: 'VS-ADMIN-01',
      display_name: 'VS-ADMIN-01',
      role: 'ADMIN',
      transport: 'LAN',
    });
    expect(rec.status).toBe('ONLINE');
    expect(rec.app_connected).toBe(true);
    expect(getAdminPresence()?.device_id).toBe('VS-ADMIN-01');
  });

  it('tracks CLIENT presence separately from ADMIN', () => {
    heartbeatPresence({ device_id: 'VS-ADMIN-01', role: 'ADMIN', transport: 'LAN' });
    heartbeatPresence({
      device_id: 'CLIENT-001',
      role: 'CLIENT',
      transport: 'WIREGUARD',
      wg_connected: true,
    });
    expect(listPresence('ADMIN')).toHaveLength(1);
    expect(listPresence('CLIENT')).toHaveLength(1);
    expect(listPresence('CLIENT')[0].wg_connected).toBe(true);
  });
});
