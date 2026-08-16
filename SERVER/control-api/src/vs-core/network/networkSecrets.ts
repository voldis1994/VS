/** Normalize secrets from env / Windows CRLF / quoted .env values. Never log the value. */
export function normalizeNetworkSecret(raw: string | undefined | null): string {
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
