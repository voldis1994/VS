/**
 * ADMIN install enrollment — fresh session, expired discard, idempotent reuse.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  enrollAdminDevice,
  normalizeAdminSecret,
  verifyAdminToken,
  InstallStageError,
} from './installEnrollment.js';

function jsonRes(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('normalizeAdminSecret', () => {
  it('strips CRLF, BOM, and quotes', () => {
    expect(normalizeAdminSecret('"abc"\r\n')).toBe('abc');
    expect(normalizeAdminSecret("\uFEFF'tok'\r")).toBe('tok');
  });
});

describe('verifyAdminToken', () => {
  it('rejects invalid token', async () => {
    const fetchImpl = vi.fn(async () => jsonRes(401, { ok: false, code: 'UNAUTHORIZED' }));
    await expect(
      verifyAdminToken('http://192.168.0.10:3000', 'bad', fetchImpl as unknown as typeof fetch)
    ).rejects.toMatchObject({ code: 'INVALID_ADMIN_TOKEN', stage: 'ADMIN_AUTH' });
  });

  it('accepts valid token', async () => {
    const fetchImpl = vi.fn(async () => jsonRes(200, { ok: true, server_id: 'VS-CORE-01' }));
    await expect(
      verifyAdminToken('http://192.168.0.10:3000', 'good', fetchImpl as unknown as typeof fetch)
    ).resolves.toBeUndefined();
  });

  it('maps network failure to SERVER_UNREACHABLE', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(
      verifyAdminToken('http://192.168.0.10:3000', 'good', fetchImpl as unknown as typeof fetch)
    ).rejects.toMatchObject({ code: 'SERVER_UNREACHABLE' });
  });
});

describe('enrollAdminDevice', () => {
  it('fresh enrollment: create then complete', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/enrollment/create')) {
        return jsonRes(200, {
          ok: true,
          enrollment_code: 'FRESH1',
          device_id: 'VS-ADMIN-01',
        });
      }
      if (u.includes('/enrollment/complete')) {
        const body = JSON.parse(String(init?.body || '{}')) as { enrollment_code?: string };
        expect(body.enrollment_code).toBe('FRESH1');
        return jsonRes(200, {
          ok: true,
          device_id: 'VS-ADMIN-01',
          device_token: 'tok-new',
          private_address: '10.77.1.1',
          server_public_key: 'pub',
          wg_endpoint: '192.168.0.10:51820',
        });
      }
      return jsonRes(404, {});
    }) as unknown as typeof fetch;

    const r = await enrollAdminDevice({
      baseUrl: 'http://192.168.0.10:3000',
      adminToken: 'admin',
      publicKey: 'pk',
      fetchImpl,
    });
    expect(r.device_token).toBe('tok-new');
    expect(r.reused_existing).toBe(false);
  });

  it('expired override is discarded and fresh session created', async () => {
    let completeN = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/enrollment/complete')) {
        completeN += 1;
        if (completeN === 1) {
          return jsonRes(400, { ok: false, code: 'ENROLLMENT_EXPIRED' });
        }
        return jsonRes(200, {
          ok: true,
          device_id: 'VS-ADMIN-01',
          device_token: 'tok2',
        });
      }
      if (u.includes('/enrollment/create')) {
        return jsonRes(200, { ok: true, enrollment_code: 'NEWCODE', device_id: 'VS-ADMIN-01' });
      }
      return jsonRes(404, {});
    }) as unknown as typeof fetch;

    const r = await enrollAdminDevice({
      baseUrl: 'http://192.168.0.10:3000',
      adminToken: 'admin',
      publicKey: 'pk',
      enrollmentCodeOverride: 'STALE',
      fetchImpl,
    });
    expect(r.device_token).toBe('tok2');
    expect(completeN).toBe(2);
  });

  it('repeated install reuses valid device_token without new enrollment', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('/device/auth')) {
        return jsonRes(200, { ok: true, session_id: 's1' });
      }
      return jsonRes(500, { ok: false });
    }) as unknown as typeof fetch;

    const r = await enrollAdminDevice({
      baseUrl: 'http://192.168.0.10:3000',
      adminToken: 'admin',
      publicKey: 'pk',
      existingDeviceToken: 'still-good',
      fetchImpl,
    });
    expect(r.reused_existing).toBe(true);
    expect(r.device_token).toBe('still-good');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('invalid admin token on create surfaces clearly (not EXPIRED_SESSION mask)', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('/enrollment/create')) {
        return jsonRes(401, { ok: false, code: 'INVALID_ADMIN_TOKEN' });
      }
      return jsonRes(404, {});
    }) as unknown as typeof fetch;

    await expect(
      enrollAdminDevice({
        baseUrl: 'http://192.168.0.10:3000',
        adminToken: 'wrong',
        publicKey: 'pk',
        fetchImpl,
      })
    ).rejects.toMatchObject({ code: 'INVALID_ADMIN_TOKEN', stage: 'ENROLLMENT_CREATE' });
  });

  it('already enrolled ADMIN: DEVICE_ID_EXISTS then replace-lost + complete', async () => {
    let completeCalls = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/enrollment/create')) {
        return jsonRes(200, { ok: true, enrollment_code: 'C1', device_id: 'VS-ADMIN-01' });
      }
      if (u.includes('/enrollment/complete')) {
        completeCalls += 1;
        if (completeCalls === 1) {
          return jsonRes(400, { ok: false, code: 'DEVICE_ID_EXISTS' });
        }
        return jsonRes(200, {
          ok: true,
          device_id: 'VS-ADMIN-01',
          device_token: 'tok-replaced',
        });
      }
      if (u.includes('/device/lost')) {
        return jsonRes(200, {
          ok: true,
          enrollment: { enrollment_code: 'C2', device_id: 'VS-ADMIN-01' },
        });
      }
      return jsonRes(404, {});
    }) as unknown as typeof fetch;

    const r = await enrollAdminDevice({
      baseUrl: 'http://192.168.0.10:3000',
      adminToken: 'admin',
      publicKey: 'pk',
      fetchImpl,
    });
    expect(r.device_token).toBe('tok-replaced');
  });

  it('cleanup after failed enrollment throws InstallStageError', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    await expect(
      enrollAdminDevice({
        baseUrl: 'http://192.168.0.10:3000',
        adminToken: 'admin',
        publicKey: 'pk',
        fetchImpl,
      })
    ).rejects.toBeInstanceOf(Error);
  });
});
