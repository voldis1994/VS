/** CLIENT enrollment + Connection Manager foundation — no ports / WG keys in UX. */

export type ClientProductConfig = {
  server_id: string;
  device_id?: string;
  device_token?: string;
  enrollment_code?: string;
};

export type ClientEnrollResult = {
  device_id: string;
  private_address: string;
  device_token: string;
  server_id: string;
  role: string;
  client_id: number | null;
};

/**
 * Complete CLIENT enrollment against SERVER Network Authority.
 * Device supplies public_key (generated locally). User enters enrollment_code only.
 */
export async function enrollClientDevice(
  input: {
    server_id: string;
    enrollment_code: string;
    public_key: string;
    device_name?: string;
    /** Resolved internally — tests may pass full base */
    authority_base_url: string;
  },
  fetchImpl: typeof fetch = fetch
): Promise<ClientEnrollResult> {
  const res = await fetchImpl(`${input.authority_base_url.replace(/\/$/, '')}/api/v1/network/enrollment/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      enrollment_code: input.enrollment_code,
      public_key: input.public_key,
      device_name: input.device_name,
    }),
  });
  const body = (await res.json()) as ClientEnrollResult & { ok?: boolean; code?: string };
  if (!res.ok || body.ok === false) {
    throw new Error(body.code || `ENROLL_HTTP_${res.status}`);
  }
  return {
    device_id: body.device_id,
    private_address: body.private_address,
    device_token: body.device_token,
    server_id: body.server_id || input.server_id,
    role: body.role,
    client_id: body.client_id,
  };
}

/** CLIENT → SERVER only. Never Capital. Never ADMIN. Never other clients. */
export type ClientConnectionConfig = {
  server_id: string;
  device_id: string;
  device_token: string;
  accessToken?: string;
  authority_base_url?: string;
};

export function assertNoCapitalCredentials(cfg: Record<string, unknown>): void {
  const banned = ['api_key', 'password', 'cst', 'security_token', 'capital'];
  for (const k of Object.keys(cfg)) {
    if (banned.some((b) => k.toLowerCase().includes(b) && k !== 'baseUrl' && k !== 'authority_base_url')) {
      throw new Error(`CLIENT_MUST_NOT_HOLD_${k}`);
    }
  }
}

export function assertNoUserFacingPort(cfg: ClientProductConfig): void {
  const s = JSON.stringify(cfg);
  if (/:\d{2,5}/.test(s) && !('authority_base_url' in (cfg as object))) {
    // Product config objects must not require users to store host:port
    throw new Error('CLIENT_CONFIG_MUST_NOT_REQUIRE_HOST_PORT');
  }
}
