/**
 * Enrollment packages — single-use, short-lived, revocable.
 * Ideal path: device generates private key locally; SERVER stores public key only.
 */

import { randomBytes } from 'crypto';
import type { DeviceRegistry } from './deviceRegistry.js';
import { ENROLLMENT_TTL_MS } from './networkConstants.js';
import { randomDeviceToken } from './wireguardKeys.js';
import { invalidateDeviceSessions } from './deviceAuth.js';

export type EnrollmentPackage = {
  enrollment_code: string;
  enrollment_id: string;
  server_id: string;
  device_type: 'ADMIN' | 'CLIENT';
  device_id: string;
  expires_at: string;
  /** Public SERVER endpoint hostname foundation (DDNS) — not a management HTTP port for users */
  server_endpoint_hostname: string | null;
  wg_listen_port: number;
  /** Client never shown internal HTTP ports — Connection Manager resolves catalog */
  note: string;
};

export function issueEnrollmentPackage(
  registry: DeviceRegistry,
  input: {
    device_type: 'ADMIN' | 'CLIENT';
    device_id?: string;
    client_id?: number | null;
    account_id?: number | null;
    ttl_ms?: number;
    created_by: string;
  }
): EnrollmentPackage {
  const meta = registry.getMeta();
  const device_id =
    input.device_id ||
    (input.device_type === 'ADMIN' ? nextAdminId(registry) : nextClientId(registry));
  if (input.device_type === 'CLIENT' && (input.client_id == null || !Number.isFinite(input.client_id))) {
    throw new Error('CLIENT_ENROLLMENT_REQUIRES_CLIENT_ID');
  }
  const enrollment_code = randomBytes(24).toString('base64url');
  const { enrollment_id, expires_at } = registry.createEnrollment({
    token: enrollment_code,
    device_type: input.device_type,
    device_id,
    client_id: input.client_id ?? null,
    account_id: input.account_id ?? null,
    ttl_ms: input.ttl_ms ?? ENROLLMENT_TTL_MS,
    created_by: input.created_by,
  });
  return {
    enrollment_code,
    enrollment_id,
    server_id: meta.server_id,
    device_type: input.device_type,
    device_id,
    expires_at,
    server_endpoint_hostname: meta.server_endpoint_hostname,
    wg_listen_port: meta.wg_listen_port,
    note: 'Enter/scan enrollment_code only — Connection Manager configures WireGuard and resolves SERVER services',
  };
}

/**
 * Complete enrollment with device-generated public key (preferred).
 * SERVER never receives the private key.
 */
export function completeEnrollment(
  registry: DeviceRegistry,
  input: {
    enrollment_code: string;
    public_key: string;
    device_name?: string;
    /** Optional: prove possession later; for now issue device_token for app session */
  }
): {
  device_id: string;
  private_address: string;
  device_token: string;
  server_id: string;
  server_public_key: string | null;
  server_endpoint_hostname: string | null;
  wg_listen_port: number;
  role: string;
  client_id: number | null;
} {
  let enr;
  try {
    enr = registry.consumeEnrollment(input.enrollment_code);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(msg);
  }
  const device_id = enr.device_id || (enr.device_type === 'ADMIN' ? nextAdminId(registry) : nextClientId(registry));
  const device_token = randomDeviceToken();
  const rec = registry.registerPending({
    device_id,
    device_name: input.device_name || device_id,
    device_type: enr.device_type,
    public_key: input.public_key,
    client_id: enr.client_id,
    account_id: enr.account_id,
    device_token,
  });
  // Possession of enrollment code + key submission → approve
  registry.approve(device_id);
  const meta = registry.getMeta();
  return {
    device_id: rec.device_id,
    private_address: rec.private_address,
    device_token,
    server_id: meta.server_id,
    server_public_key: meta.server_public_key,
    server_endpoint_hostname: meta.server_endpoint_hostname,
    wg_listen_port: meta.wg_listen_port,
    role: rec.role,
    client_id: rec.client_id,
  };
}

export function revokeEnrollmentPackage(registry: DeviceRegistry, enrollmentId: string): void {
  registry.revokeEnrollment(enrollmentId);
}

export function nextAdminId(registry: DeviceRegistry): string {
  const n = registry.list().filter((d) => d.device_type === 'ADMIN').length + 1;
  return `VS-ADMIN-${String(n).padStart(2, '0')}`;
}

export function nextClientId(registry: DeviceRegistry): string {
  const n = registry.list().filter((d) => d.device_type === 'CLIENT').length + 1;
  return `VS-CLIENT-${String(n).padStart(6, '0')}`;
}

/** Lost device: revoke old, issue new enrollment. */
export function replaceLostDevice(
  registry: DeviceRegistry,
  oldDeviceId: string,
  created_by: string
): EnrollmentPackage {
  const old = registry.get(oldDeviceId);
  if (!old) throw new Error('DEVICE_NOT_FOUND');
  if (old.status !== 'REVOKED') {
    registry.revoke(oldDeviceId);
    invalidateDeviceSessions(oldDeviceId);
  }
  return issueEnrollmentPackage(registry, {
    device_type: old.device_type === 'ADMIN' ? 'ADMIN' : 'CLIENT',
    client_id: old.client_id,
    account_id: old.account_id,
    created_by,
  });
}
