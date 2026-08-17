/**
 * ADMIN install enrollment orchestration — testable, idempotent, LAN-safe.
 * Never reuses expired enrollment codes from local config.
 */

export type EnrollResult = {
  device_id: string;
  device_token: string;
  private_address?: string;
  server_public_key?: string | null;
  wg_endpoint?: string | null;
  reused_existing: boolean;
};

export type StageLogger = (stage: string, detail?: string) => void;

export function normalizeAdminSecret(raw: string | undefined | null): string {
  let s = String(raw ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r/g, '')
    .trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

export class InstallStageError extends Error {
  stage: string;
  code: string;
  constructor(stage: string, code: string, message?: string) {
    super(message || code);
    this.stage = stage;
    this.code = code;
  }
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function errCode(body: Record<string, unknown>, fallback: string): string {
  return typeof body.code === 'string' && body.code ? body.code : fallback;
}

/** Verify API_ADMIN_TOKEN against real ADMIN ping — never logs the token. */
export async function verifyAdminToken(
  baseUrl: string,
  adminToken: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const token = normalizeAdminSecret(adminToken);
  if (!token || token === 'CHANGE_ME_ADMIN_TOKEN') {
    throw new InstallStageError('ADMIN_AUTH', 'ADMIN_TOKEN_REQUIRED', 'API_ADMIN_TOKEN missing');
  }
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/api/v1/admin/ping`, {
      headers: { 'x-admin-token': token, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    throw new InstallStageError(
      'ADMIN_AUTH',
      'SERVER_UNREACHABLE',
      e instanceof Error ? e.message : 'network error'
    );
  }
  const body = await readJson(res);
  if (res.status === 401) {
    throw new InstallStageError(
      'ADMIN_AUTH',
      'INVALID_ADMIN_TOKEN',
      'server rejected API_ADMIN_TOKEN'
    );
  }
  if (!res.ok) {
    throw new InstallStageError(
      'ADMIN_AUTH',
      errCode(body, `ADMIN_PING_HTTP_${res.status}`),
      'admin ping failed'
    );
  }
}

async function tryReuseDeviceAuth(
  baseUrl: string,
  deviceId: string,
  deviceToken: string,
  fetchImpl: typeof fetch
): Promise<boolean> {
  if (!deviceToken) return false;
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/api/v1/network/device/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_id: deviceId, device_token: deviceToken }),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function createFreshEnrollment(
  baseUrl: string,
  adminToken: string,
  deviceId: string,
  fetchImpl: typeof fetch
): Promise<{ enrollment_code: string; device_id: string }> {
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/api/v1/network/enrollment/create`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-token': normalizeAdminSecret(adminToken),
      },
      body: JSON.stringify({ device_type: 'ADMIN', device_id: deviceId }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    throw new InstallStageError(
      'ENROLLMENT_CREATE',
      'SERVER_UNREACHABLE',
      e instanceof Error ? e.message : 'network error'
    );
  }
  const body = await readJson(res);
  if (!res.ok || typeof body.enrollment_code !== 'string') {
    throw new InstallStageError(
      'ENROLLMENT_CREATE',
      errCode(body, `ENROLL_CREATE_HTTP_${res.status}`),
      'could not create enrollment session'
    );
  }
  return {
    enrollment_code: body.enrollment_code,
    device_id: typeof body.device_id === 'string' ? body.device_id : deviceId,
  };
}

async function replaceLostAndEnroll(
  baseUrl: string,
  adminToken: string,
  deviceId: string,
  fetchImpl: typeof fetch
): Promise<{ enrollment_code: string; device_id: string }> {
  const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/api/v1/network/device/lost`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-admin-token': normalizeAdminSecret(adminToken),
    },
    body: JSON.stringify({ device_id: deviceId }),
    signal: AbortSignal.timeout(10000),
  });
  const body = await readJson(res);
  const enrollment = body.enrollment as { enrollment_code?: string; device_id?: string } | undefined;
  if (!res.ok || !enrollment?.enrollment_code) {
    throw new InstallStageError(
      'ENROLLMENT_REPLACE',
      errCode(body, `DEVICE_LOST_HTTP_${res.status}`),
      'could not replace lost ADMIN device'
    );
  }
  return {
    enrollment_code: enrollment.enrollment_code,
    device_id: enrollment.device_id || deviceId,
  };
}

async function completeEnrollment(
  baseUrl: string,
  enrollmentCode: string,
  publicKey: string,
  deviceName: string,
  fetchImpl: typeof fetch
): Promise<{
  device_id: string;
  device_token: string;
  private_address?: string;
  server_public_key?: string | null;
  wg_endpoint?: string | null;
}> {
  const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/api/v1/network/enrollment/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      enrollment_code: enrollmentCode,
      public_key: publicKey,
      device_name: deviceName,
    }),
    signal: AbortSignal.timeout(10000),
  });
  const body = await readJson(res);
  if (!res.ok || typeof body.device_token !== 'string') {
    throw new InstallStageError(
      'ENROLLMENT_COMPLETE',
      errCode(body, `ENROLL_COMPLETE_HTTP_${res.status}`),
      'enrollment complete failed'
    );
  }
  return {
    device_id: typeof body.device_id === 'string' ? body.device_id : deviceName,
    device_token: body.device_token,
    private_address: typeof body.private_address === 'string' ? body.private_address : undefined,
    server_public_key:
      typeof body.server_public_key === 'string' ? body.server_public_key : null,
    wg_endpoint: typeof body.wg_endpoint === 'string' ? body.wg_endpoint : null,
  };
}

/**
 * Product path:
 * 1) reuse valid device_token if present
 * 2) else create FRESH enrollment via API_ADMIN_TOKEN (never stale local codes)
 * 3) complete with device-local public key
 * 4) if device already registered, replace-lost then complete once
 *
 * Explicit VS_ENROLLMENT_CODE is allowed only as a one-shot override (fresh from server).
 * Expired codes are discarded and a new session is created.
 */
export async function enrollAdminDevice(input: {
  baseUrl: string;
  adminToken: string;
  publicKey: string;
  deviceId?: string;
  existingDeviceToken?: string;
  /** Optional one-shot code from operator; never persist for reuse after expiry */
  enrollmentCodeOverride?: string;
  fetchImpl?: typeof fetch;
  log?: StageLogger;
}): Promise<EnrollResult> {
  const fetchImpl = input.fetchImpl || fetch;
  const log = input.log || (() => undefined);
  const deviceId = input.deviceId || 'VS-ADMIN-01';
  const adminToken = normalizeAdminSecret(input.adminToken);
  const baseUrl = input.baseUrl.replace(/\/$/, '');

  const existingTok = normalizeAdminSecret(input.existingDeviceToken);
  if (existingTok) {
    const ok = await tryReuseDeviceAuth(baseUrl, deviceId, existingTok, fetchImpl);
    if (ok) {
      log('DEVICE_ENROLLED', 'reused existing device credentials');
      return {
        device_id: deviceId,
        device_token: existingTok,
        reused_existing: true,
      };
    }
    log('DEVICE_REENROLL', 'existing device_token rejected; creating fresh enrollment');
  }

  let code = normalizeAdminSecret(input.enrollmentCodeOverride);
  if (code) {
    try {
      const done = await completeEnrollment(baseUrl, code, input.publicKey, deviceId, fetchImpl);
      log('DEVICE_ENROLLED', done.device_id);
      return { ...done, reused_existing: false };
    } catch (e) {
      const codeName = e instanceof InstallStageError ? e.code : '';
      if (
        codeName === 'ENROLLMENT_EXPIRED' ||
        codeName === 'ENROLLMENT_USED' ||
        codeName === 'ENROLLMENT_REVOKED' ||
        codeName === 'ENROLLMENT_INVALID'
      ) {
        log('ENROLLMENT_SESSION_EXPIRED', 'discarding override; creating fresh session');
        code = '';
      } else if (codeName === 'DEVICE_ID_EXISTS' || codeName === 'PUBLIC_KEY_EXISTS') {
        log('ENROLLMENT_REPLACE', 'issuing replacement enrollment for existing ADMIN device');
        const replaced = await replaceLostAndEnroll(baseUrl, adminToken, deviceId, fetchImpl);
        log('ENROLLMENT_SESSION_CREATED', replaced.device_id);
        const done = await completeEnrollment(
          baseUrl,
          replaced.enrollment_code,
          input.publicKey,
          deviceId,
          fetchImpl
        );
        log('DEVICE_ENROLLED', done.device_id);
        return { ...done, reused_existing: false };
      } else {
        throw e;
      }
    }
  }

  if (!code) {
    try {
      const created = await createFreshEnrollment(baseUrl, adminToken, deviceId, fetchImpl);
      code = created.enrollment_code;
      log('ENROLLMENT_SESSION_CREATED', created.device_id);
    } catch (e) {
      // Auth failures must not be masked as device-lost
      if (e instanceof InstallStageError) {
        if (
          e.code === 'INVALID_ADMIN_TOKEN' ||
          e.code === 'ADMIN_TOKEN_REQUIRED' ||
          e.code === 'EXPIRED_SESSION' ||
          e.code === 'UNAUTHORIZED'
        ) {
          throw e;
        }
      }
      throw e;
    }
  }

  try {
    const done = await completeEnrollment(baseUrl, code, input.publicKey, deviceId, fetchImpl);
    log('DEVICE_ENROLLED', done.device_id);
    return { ...done, reused_existing: false };
  } catch (e) {
    const codeName = e instanceof InstallStageError ? e.code : '';
    if (
      codeName === 'DEVICE_ID_EXISTS' ||
      codeName === 'PUBLIC_KEY_EXISTS' ||
      codeName === 'ENROLLMENT_EXPIRED' ||
      codeName === 'ENROLLMENT_USED'
    ) {
      log('ENROLLMENT_REPLACE', 'issuing replacement enrollment for existing ADMIN device');
      const replaced = await replaceLostAndEnroll(baseUrl, adminToken, deviceId, fetchImpl);
      log('ENROLLMENT_SESSION_CREATED', replaced.device_id);
      const done = await completeEnrollment(
        baseUrl,
        replaced.enrollment_code,
        input.publicKey,
        deviceId,
        fetchImpl
      );
      log('DEVICE_ENROLLED', done.device_id);
      return { ...done, reused_existing: false };
    }
    throw e;
  }
}
