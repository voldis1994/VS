import { createPublicKey, publicEncrypt, constants } from 'crypto';

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

/** RSA encrypt password|timestamp per Capital.com session docs. */
export function encryptCapitalPassword(
  encryptionKeyBase64: string,
  timeStamp: number | string,
  password: string
): string {
  const mixed = Buffer.from(`${password}|${timeStamp}`, 'utf8').toString('base64');
  const key = createPublicKey({
    key: Buffer.from(encryptionKeyBase64, 'base64'),
    format: 'der',
    type: 'spki',
  });
  const encrypted = publicEncrypt(
    { key, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(mixed, 'utf8')
  );
  return encrypted.toString('base64');
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

  const parts = [
    `Capital.com ${env} login failed (HTTP ${input.status}, ${code}).`,
  ];

  if (input.message && input.message.toLowerCase() !== 'bad request') {
    parts.push(`Broker says: ${input.message}`);
  } else if (input.bodyText && input.bodyText.length < 300) {
    parts.push(`Raw: ${input.bodyText}`);
  }

  parts.push(
    `2FA note: 2FA is only for creating the API key in the Capital.com website — do NOT paste the 2FA code into API Password.`,
    `Use the custom API password you set when generating the key (Settings → API integrations), NOT your account login password.`,
    `Checklist: (1) Live key for Live / Demo key for Demo.`,
    `(2) Identifier = login email.`,
    `(3) API Key = key string.`,
    `(4) API Password = custom password from key creation.`,
    `(5) Re-save broker row, Test again.`
  );

  return parts.join(' ');
}

async function createSession(
  base: string,
  apiKey: string,
  identifier: string,
  password: string,
  encryptedPassword: boolean
): Promise<{ res: Response; text: string; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/v1/session`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-CAP-API-KEY': apiKey,
    },
    body: JSON.stringify({
      identifier,
      password,
      encryptedPassword,
    }),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = {};
  }
  return { res, text, json };
}

/**
 * Create a Capital.com REST session (does not keep it open).
 * Prefers encryptedPassword flow; falls back to plain password.
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
  // Heuristic: 6-digit OTP pasted by mistake
  if (/^\d{6}$/.test(password)) {
    return {
      ok: false,
      status: 0,
      detail:
        'API Password looks like a 2FA code. Use the custom API password from key creation, not the authenticator code.',
    };
  }

  const base = capitalComBaseUrl(environment);

  let encryptedOk = false;
  let passwordToSend = password;
  let useEncrypted = false;

  try {
    const encRes = await fetch(`${base}/api/v1/session/encryptionKey`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-CAP-API-KEY': apiKey,
      },
    });
    const encText = await encRes.text();
    if (encRes.ok) {
      const encJson = JSON.parse(encText) as { encryptionKey?: string; timeStamp?: number | string };
      if (encJson.encryptionKey != null && encJson.timeStamp != null) {
        passwordToSend = encryptCapitalPassword(
          encJson.encryptionKey,
          encJson.timeStamp,
          password
        );
        useEncrypted = true;
        encryptedOk = true;
      }
    }
  } catch {
    // fall back to plain password
  }

  const attempts: Array<{ encrypted: boolean; password: string; label: string }> = [];
  if (useEncrypted) {
    attempts.push({ encrypted: true, password: passwordToSend, label: 'encrypted' });
  }
  attempts.push({ encrypted: false, password, label: 'plain' });

  let lastFail: CapitalComSessionResult | null = null;

  for (const attempt of attempts) {
    let res: Response;
    let text: string;
    let json: Record<string, unknown>;
    try {
      ({ res, text, json } = await createSession(
        base,
        apiKey,
        identifier,
        attempt.password,
        attempt.encrypted
      ));
    } catch (err) {
      return {
        ok: false,
        status: 0,
        detail: `Network error reaching Capital.com (${base}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }

    if (!res.ok) {
      const errorCode = String(json.errorCode || json.error || '');
      const message = String(json.message || json.errorMessage || json.errorReason || '');
      lastFail = {
        ok: false,
        status: res.status,
        errorCode: errorCode || undefined,
        detail: explainCapitalError({
          environment,
          status: res.status,
          errorCode,
          message: message || res.statusText || '',
          bodyText: text,
        }) + (encryptedOk ? ` (tried ${attempt.label} password)` : ''),
      };
      continue;
    }

    const cst = res.headers.get('CST') || res.headers.get('cst');
    const sec = res.headers.get('X-SECURITY-TOKEN') || res.headers.get('x-security-token');
    if (!cst || !sec) {
      lastFail = {
        ok: false,
        status: res.status,
        detail:
          'Capital.com returned HTTP OK but without CST / X-SECURITY-TOKEN headers. Check API key permissions for session create.',
      };
      continue;
    }

    try {
      await fetch(`${base}/api/v1/session`, {
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
      detail: `Capital.com ${environment.toUpperCase()} session OK (${attempt.label})`,
      accountType: typeof json.accountType === 'string' ? json.accountType : undefined,
    };
  }

  return (
    lastFail || {
      ok: false,
      status: 0,
      detail: 'Capital.com session failed with no response',
    }
  );
}
