/**
 * Client request authorization — server-side only.
 * Expects Authorization: Bearer <device-session-token> or x-client-token.
 * Does NOT accept API_ADMIN_TOKEN as client auth.
 */

export type ClientAuthOk = {
  ok: true;
  clientId: string;
  deviceId: string;
  expiresAt: string | null;
};

export type ClientAuthFail = {
  ok: false;
  status: 401 | 403;
  code: string;
};

export function authorizeClientRequest(req: {
  headers: Record<string, unknown>;
}): ClientAuthOk | ClientAuthFail {
  const headers = req.headers || {};
  const admin =
    String(headers['x-admin-token'] || headers['x-api-admin-token'] || '').trim();
  if (admin) {
    return { ok: false, status: 403, code: 'ADMIN_TOKEN_NOT_ALLOWED_ON_CLIENT_API' };
  }

  const bearer = String(headers.authorization || '');
  const token =
    (bearer.toLowerCase().startsWith('bearer ')
      ? bearer.slice(7).trim()
      : String(headers['x-client-token'] || '').trim()) || '';

  if (!token) {
    return { ok: false, status: 401, code: 'UNAUTHORIZED' };
  }
  if (/CHANGE_ME|changeme/i.test(token)) {
    return { ok: false, status: 401, code: 'INVALID_TOKEN' };
  }

  // Production wiring injects session lookup; boundary check is enforced here.
  // Without a verified session store, deny rather than invent identity.
  const verified = (globalThis as { __VS_CLIENT_SESSION_LOOKUP?: (t: string) => ClientAuthOk | null })
    .__VS_CLIENT_SESSION_LOOKUP?.(token);
  if (verified) return verified;

  return { ok: false, status: 401, code: 'SESSION_NOT_VERIFIED' };
}
