/**
 * Client API helpers.
 *
 * Security: tokens are NOT stored in localStorage — doing so exposes them to
 * any XSS or same-origin script.  The session is maintained exclusively via
 * HttpOnly/Secure/SameSite cookies set by the server.  The bearer token
 * returned at login is kept in memory only (React state) and cleared on page
 * unload.  All requests use `credentials: 'include'` so the cookie is sent
 * automatically.
 */

/** Same-origin when served by VS CORE; optional override for local vite preview. */
export function apiBase(): string {
  const fromEnv = (import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  return '';
}

/**
 * Read the in-memory bearer token from the module-level store.
 * Falls back to null — the server will accept the HttpOnly cookie instead.
 */
let _memoryToken: string | null = null;

export function getClientToken(): string | null {
  return _memoryToken;
}

export function setClientToken(token: string | null) {
  _memoryToken = token;
}

export async function clientFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers as Record<string, string> | undefined),
  };
  const token = getClientToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${apiBase()}${path}`, {
    ...options,
    headers,
    credentials: 'include', // always send HttpOnly session cookie
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text };
  }
  if (!res.ok) {
    const msg =
      (data as { message?: string; error?: string })?.message ||
      (data as { error?: string })?.error ||
      `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data as T;
}
