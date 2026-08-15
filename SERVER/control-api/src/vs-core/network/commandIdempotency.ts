/**
 * Command idempotency — state-changing ADMIN/CLIENT commands carry command_id.
 * Reconnect / duplicate POST must not execute START/STOP/lot/market twice.
 */

import type { DeviceRegistry } from './deviceRegistry.js';

export type CommandKind =
  | 'START'
  | 'STOP'
  | 'LOT_CHANGE'
  | 'MARKET_CHANGE'
  | 'ADMIN_ACTION'
  | string;

export type IdempotentResult<T> =
  | { ok: true; duplicate: false; result: T }
  | { ok: true; duplicate: true; result: T }
  | { ok: false; code: string; reason: string };

/**
 * Execute once per command_id. Connection lifecycle (heartbeat/reconnect) must NOT call this.
 */
export function executeIdempotent<T>(
  registry: DeviceRegistry,
  input: {
    command_id: string;
    device_id: string;
    kind: CommandKind;
    execute: () => T;
  }
): IdempotentResult<T> {
  if (!input.command_id || input.command_id.length < 8) {
    return { ok: false, code: 'INVALID_COMMAND_ID', reason: 'command_id required' };
  }
  const existing = registry.getCommandResult(input.command_id);
  if (existing !== undefined) {
    return { ok: true, duplicate: true, result: existing as T };
  }
  const result = input.execute();
  registry.putCommandResult(input.command_id, input.device_id, result);
  return { ok: true, duplicate: false, result };
}
