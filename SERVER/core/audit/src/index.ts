/** Audit event helper — never log secrets. */

const SECRET_KEYS = /token|password|secret|authorization|api[_-]?key/i;

export type AuditEvent = {
  actor: string;
  action: string;
  resource: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
};

export function sanitizeAuditDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) {
    out[k] = SECRET_KEYS.test(k) ? '[REDACTED]' : v;
  }
  return out;
}

export function buildAuditEvent(input: {
  actor: string;
  action: string;
  resource?: string | null;
  detail?: Record<string, unknown>;
}): AuditEvent {
  return {
    actor: input.actor,
    action: input.action,
    resource: input.resource ?? null,
    detail: sanitizeAuditDetail(input.detail || {}),
    createdAt: new Date().toISOString(),
  };
}
