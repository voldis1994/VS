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
  errorCode?: string;
  accountType?: string;
}

function explainCapitalError(input: {
  environment: string;
  status: number;
  errorCode: string;
  message: string;
  bodyText: string;
}): string {
  const env = input.environment.toUpperCase();
  const code = input.errorCode || '(no errorCode)';
  const msg = (input.message || input.bodyText || '').trim() || input.status ? `HTTP ${input.status}` : 'unknown';

  const parts = [
    `Capital.com ${env} login failed (HTTP ${input.status}, ${code}).`,
  ];

  if (input.message && input.message.toLowerCase() !== 'bad request') {
    parts.push(`Broker says: ${input.message}`);
  } else if (input.bodyText && input.bodyText.length < 300) {
    parts.push(`Raw: ${input.bodyText}`);
  }

  parts.push(
    `Fix checklist: (1) Capital.com → Settings → API → create key for ${env} (Demo key will NOT work on Live).`,
    `(2) Identifier = login email.`,
    `(3) API Key = key string (not email).`,
    `(4) API Password = API password from that same key.`,
    `(5) Re-save the broker row, then Test again.`
  );

  return parts.join(' ');
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
  const apiKey = input.apiKey.trim();
  const identifier = input.identifier.trim();
  const password = input.password.trim();
  const environment = (input.environment || 'demo').toLowerCase();

  if (!apiKey || !identifier || !password) {
    return {
      ok: false,
      status: 0,
      detail: 'Missing identifier, API key, or password after trim',
    };
  }
  if (apiKey.includes('@')) {
    return {
      ok: false,
      status: 0,
      detail:
        'API Key looks like an email. Put email in Identifier; paste Capital.com API Key into API Key.',
    };
  }

  const base = capitalComBaseUrl(environment);
  const url = `${base}/api/v1/session`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-CAP-API-KEY': apiKey,
      },
      body: JSON.stringify({
        identifier,
        password,
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
    const message = String(
      json.message || json.errorMessage || json.errorReason || ''
    );
    return {
      ok: false,
      status: res.status,
      errorCode: errorCode || undefined,
      detail: explainCapitalError({
        environment,
        status: res.status,
        errorCode,
        message: message || res.statusText || '',
        bodyText: text,
      }),
    };
  }

  const cst = res.headers.get('CST') || res.headers.get('cst');
  const sec = res.headers.get('X-SECURITY-TOKEN') || res.headers.get('x-security-token');
  if (!cst || !sec) {
    return {
      ok: false,
      status: res.status,
      detail:
        'Capital.com returned HTTP OK but without CST / X-SECURITY-TOKEN headers. Check API key permissions for session create.',
    };
  }

  try {
    await fetch(url, {
      method: 'DELETE',
      headers: {
        'X-CAP-API-KEY': apiKey,
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
    detail: `Capital.com ${environment.toUpperCase()} session OK`,
    accountType: typeof json.accountType === 'string' ? json.accountType : undefined,
  };
}
