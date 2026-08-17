/**
 * ADMIN device enrollment — public key stays device-local; private key never uploaded.
 */

import { generateKeyPairSync, createHash } from 'crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'fs';
import { join } from 'path';

export type DeviceKeyPair = { privateKey: string; publicKey: string };

/** WireGuard-compatible X25519 raw keys as base64 (32 bytes). */
export function generateDeviceX25519KeyPair(): DeviceKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const privDer = privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer;
  const pubDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return {
    privateKey: Buffer.from(privDer).subarray(privDer.length - 32).toString('base64'),
    publicKey: Buffer.from(pubDer).subarray(pubDer.length - 32).toString('base64'),
  };
}

export function ensureDeviceKeys(keysDir: string): DeviceKeyPair {
  mkdirSync(keysDir, { recursive: true });
  const privPath = join(keysDir, 'device.private');
  const pubPath = join(keysDir, 'device.public');
  if (existsSync(privPath) && existsSync(pubPath)) {
    return {
      privateKey: readFileSync(privPath, 'utf8').trim(),
      publicKey: readFileSync(pubPath, 'utf8').trim(),
    };
  }
  const pair = generateDeviceX25519KeyPair();
  writeFileSync(privPath, pair.privateKey + '\n', { mode: 0o600 });
  writeFileSync(pubPath, pair.publicKey + '\n', { mode: 0o600 });
  try {
    chmodSync(privPath, 0o600);
    chmodSync(pubPath, 0o600);
  } catch {
    /* Windows may ignore mode */
  }
  return pair;
}

export function publicKeyFingerprint(publicKey: string): string {
  return createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
}

export type EnrollCompleteResult = {
  device_id: string;
  private_address: string;
  device_token: string;
  server_id: string;
  server_public_key: string | null;
  wg_endpoint: string | null;
  wg_listen_port: number;
  role: string;
  client_id: number | null;
};

export async function completeAdminEnrollment(
  input: {
    baseUrl: string;
    enrollment_code: string;
    public_key: string;
    device_name?: string;
  },
  fetchImpl: typeof fetch = fetch
): Promise<EnrollCompleteResult> {
  const res = await fetchImpl(
    `${input.baseUrl.replace(/\/$/, '')}/api/v1/network/enrollment/complete`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enrollment_code: input.enrollment_code,
        public_key: input.public_key,
        device_name: input.device_name || 'VS-ADMIN-01',
      }),
    }
  );
  const body = (await res.json()) as EnrollCompleteResult & { ok?: boolean; code?: string };
  if (!res.ok || body.ok === false) {
    throw new Error(body.code || `ENROLL_HTTP_${res.status}`);
  }
  return {
    device_id: body.device_id,
    private_address: body.private_address,
    device_token: body.device_token,
    server_id: body.server_id,
    server_public_key: body.server_public_key,
    wg_endpoint: body.wg_endpoint || null,
    wg_listen_port: body.wg_listen_port,
    role: body.role,
    client_id: body.client_id,
  };
}

export async function createAdminEnrollment(
  input: {
    baseUrl: string;
    adminToken: string;
    device_id?: string;
  },
  fetchImpl: typeof fetch = fetch
): Promise<{ enrollment_code: string; enrollment_id: string; device_id: string }> {
  const res = await fetchImpl(
    `${input.baseUrl.replace(/\/$/, '')}/api/v1/network/enrollment/create`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-token': input.adminToken,
      },
      body: JSON.stringify({
        device_type: 'ADMIN',
        device_id: input.device_id || 'VS-ADMIN-01',
      }),
    }
  );
  const body = (await res.json()) as {
    ok?: boolean;
    code?: string;
    enrollment_code?: string;
    enrollment_id?: string;
    device_id?: string;
  };
  if (!res.ok || !body.enrollment_code) {
    throw new Error(body.code || `ENROLL_CREATE_HTTP_${res.status}`);
  }
  return {
    enrollment_code: body.enrollment_code,
    enrollment_id: body.enrollment_id || '',
    device_id: body.device_id || input.device_id || 'VS-ADMIN-01',
  };
}

/** Replace lost ADMIN device and return a fresh enrollment package. */
export async function replaceLostAdminDevice(
  input: { baseUrl: string; adminToken: string; device_id: string },
  fetchImpl: typeof fetch = fetch
): Promise<{ enrollment_code: string; device_id: string }> {
  const res = await fetchImpl(
    `${input.baseUrl.replace(/\/$/, '')}/api/v1/network/device/lost`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-token': input.adminToken,
      },
      body: JSON.stringify({ device_id: input.device_id }),
    }
  );
  const body = (await res.json()) as {
    ok?: boolean;
    code?: string;
    enrollment?: { enrollment_code?: string; device_id?: string };
  };
  if (!res.ok || !body.enrollment?.enrollment_code) {
    throw new Error(body.code || `DEVICE_LOST_HTTP_${res.status}`);
  }
  return {
    enrollment_code: body.enrollment.enrollment_code,
    device_id: body.enrollment.device_id || input.device_id,
  };
}

export function renderAdminPeerWgConf(input: {
  privateKey: string;
  privateAddress: string;
  serverPublicKey: string;
  endpoint: string;
}): string {
  const addr = input.privateAddress.includes('/')
    ? input.privateAddress
    : `${input.privateAddress}/32`;
  return [
    '# VS ADMIN peer — generated locally; private key never leaves this machine',
    '# Import into WireGuard for remote (non-LAN) access to VS-CORE-01',
    '[Interface]',
    `Address = ${addr}`,
    `PrivateKey = ${input.privateKey}`,
    '',
    '[Peer]',
    `PublicKey = ${input.serverPublicKey}`,
    `Endpoint = ${input.endpoint}`,
    'AllowedIPs = 10.77.0.0/16',
    'PersistentKeepalive = 25',
    '',
  ].join('\n');
}
