/**
 * Entry confirmation — setup must already PASS; this only binds price reference.
 */

import type { SetupRecord } from '../../market-intelligence/src/types.ts';

export function confirmEntry(setup: SetupRecord): {
  ok: boolean;
  direction: 'LONG' | 'SHORT' | null;
  entry_price: number | null;
  reason: string;
} {
  if (!setup.all_pass || !setup.direction) {
    return {
      ok: false,
      direction: null,
      entry_price: null,
      reason: setup.block || 'NO_SETUP',
    };
  }
  if (setup.entry_reference == null || !(setup.entry_reference > 0)) {
    return {
      ok: false,
      direction: setup.direction,
      entry_price: null,
      reason: 'INSUFFICIENT_DATA',
    };
  }
  return {
    ok: true,
    direction: setup.direction,
    entry_price: setup.entry_reference,
    reason: 'setup_pass',
  };
}
