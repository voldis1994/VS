/**
 * Network security audit — non-sensitive. Never log private keys or raw tokens.
 */

import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';

export type NetworkAuditAction =
  | 'DEVICE_CREATED'
  | 'DEVICE_APPROVED'
  | 'DEVICE_REVOKED'
  | 'KEY_ROTATED'
  | 'ENROLLMENT_CREATED'
  | 'ENROLLMENT_COMPLETED'
  | 'ENROLLMENT_REVOKED'
  | 'LOGIN'
  | 'LOGOUT'
  | 'AUTH_FAILED'
  | 'PERMISSION_DENIED'
  | 'COMMAND_EXECUTED'
  | 'COMMAND_DUPLICATE';

export type NetworkAuditEvent = {
  at: string;
  action: NetworkAuditAction;
  actor: string;
  device_id?: string | null;
  result: 'OK' | 'DENIED' | 'ERROR';
  detail?: Record<string, unknown>;
};

const SENSITIVE_KEYS = /private|token|secret|password|key_material|enrollment_code/i;

function scrub(detail?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!detail) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) {
    if (SENSITIVE_KEYS.test(k)) {
      out[k] = '[REDACTED]';
    } else if (typeof v === 'string' && v.length > 80 && /[=+/]/.test(v)) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function appendNetworkAudit(
  dataRoot: string,
  event: Omit<NetworkAuditEvent, 'at'> & { at?: string }
): NetworkAuditEvent {
  const full: NetworkAuditEvent = {
    at: event.at || new Date().toISOString(),
    action: event.action,
    actor: event.actor,
    device_id: event.device_id ?? null,
    result: event.result,
    detail: scrub(event.detail),
  };
  const path = join(dataRoot, 'network', 'audit.jsonl');
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(full) + '\n', { mode: 0o600 });
  return full;
}

export function assertNoSecretsInAuditFile(dataRoot: string, bannedSubstrings: string[]): void {
  const path = join(dataRoot, 'network', 'audit.jsonl');
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  for (const b of bannedSubstrings) {
    if (b && text.includes(b)) {
      throw new Error(`AUDIT_LEAK: sensitive value found in audit log`);
    }
  }
}
