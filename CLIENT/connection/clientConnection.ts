/** CLIENT → SERVER only. Never Capital. */
export type ClientConnectionConfig = {
  baseUrl: string;
  /** Session token from SERVER login — never Capital credentials */
  accessToken: string;
};

export function assertNoCapitalCredentials(cfg: Record<string, unknown>): void {
  const banned = ['api_key', 'password', 'cst', 'security_token', 'capital'];
  for (const k of Object.keys(cfg)) {
    if (banned.some((b) => k.toLowerCase().includes(b) && k !== 'baseUrl')) {
      throw new Error(`CLIENT_MUST_NOT_HOLD_${k}`);
    }
  }
}
