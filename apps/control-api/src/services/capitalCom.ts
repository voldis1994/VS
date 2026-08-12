export type CapitalComEnv = 'demo' | 'live';

export function capitalComBaseUrl(environment: string): string {
  return environment === 'live'
    ? 'https://api-capital.backend-capital.com'
    : 'https://demo-api-capital.backend-capital.com';
}

export interface CapitalComSessionResult {
  ok: boolean;
  status: number;
  detail: string;
  accountType?: string;
}

/**
 * Create a Capital.com REST session (does not keep it open).
 * Docs: https://open-api.capital.com/
 */
export async function testCapitalComSession(input: {
  environment: string;
  apiKey: string;
  identifier: string;
  password: string;
}): Promise<CapitalComSessionResult> {
  const base = capitalComBaseUrl(input.environment);
  const url = `${base}/api/v1/session`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CAP-API-KEY': input.apiKey,
      },
      body: JSON.stringify({
        identifier: input.identifier,
        password: input.password,
        encryptedPassword: false,
      }),
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      detail: `Network error reaching Capital.com (${base}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = {};
  }

  if (!res.ok) {
    const errorCode = String(json.errorCode || json.error || '');
    const message = String(json.message || json.errorMessage || text || res.statusText);
    let hint = message || `HTTP ${res.status}`;
    if (res.status === 401 || errorCode.includes('security') || /invalid|unauthor/i.test(hint)) {
      hint =
        `Capital.com rejected credentials for ${input.environment.toUpperCase()}. ` +
        `Use the API Key + API Password from Capital.com (Settings → API), ` +
        `Identifier = login email, and match Demo vs Live environment.`;
    }
    return { ok: false, status: res.status, detail: hint };
  }

  const cst = res.headers.get('CST') || res.headers.get('cst');
  const sec = res.headers.get('X-SECURITY-TOKEN') || res.headers.get('x-security-token');
  if (!cst || !sec) {
    return {
      ok: false,
      status: res.status,
      detail: 'Capital.com login returned OK but missing CST / X-SECURITY-TOKEN headers',
    };
  }

  // Best-effort logout so we don't leave sessions open.
  try {
    await fetch(url, {
      method: 'DELETE',
      headers: {
        'X-CAP-API-KEY': input.apiKey,
        CST: cst,
        'X-SECURITY-TOKEN': sec,
      },
    });
  } catch {
    // ignore logout failures
  }

  return {
    ok: true,
    status: res.status,
    detail: `Capital.com ${input.environment} session OK`,
    accountType: typeof json.accountType === 'string' ? json.accountType : undefined,
  };
}
