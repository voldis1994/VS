import { existsSync, readFileSync } from 'fs';

/** Stable CLIENT homepage. PALAID must not overwrite ADMIN/config/client-url.txt. */
export function stablePublicClientUrl(): string | null {
  const file = process.env.VS_CLIENT_URL_FILE || '/etc/vs/client-url';
  try {
    if (existsSync(file)) {
      const line = readFileSync(file, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith('#') && /https?:\/\//i.test(l));
      if (line) return line.replace(/\/$/, '') + '/';
    }
  } catch {
    /* ignore */
  }
  const env = String(process.env.VS_PUBLIC_CLIENT_URL || '').trim();
  if (env) return env.replace(/\/$/, '') + '/';
  return null;
}
