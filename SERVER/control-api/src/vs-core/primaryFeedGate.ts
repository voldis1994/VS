/**
 * PRIMARY feed gate for money path — REFERENCE never authorizes execution alone.
 */

import type { FeedManager } from './feedManager.js';

export function allowEntryFromPrimaryFeed(
  feeds: FeedManager,
  epic: string
): { ok: boolean; reason: string; code?: string } {
  const snap = feeds.snapshot(epic);
  if (snap.allows_execution && snap.primary_status === 'LIVE') {
    return { ok: true, reason: 'PRIMARY LIVE' };
  }
  if (snap.primary_status === 'OFFLINE' || snap.primary_status === 'MISSING') {
    return {
      ok: false,
      reason: snap.block_reason || 'PRIMARY_FEED_OFFLINE',
      code: 'PRIMARY_FEED_OFFLINE',
    };
  }
  if (snap.primary_status === 'STALE') {
    return {
      ok: false,
      reason: snap.block_reason || 'PRIMARY_FEED_STALE',
      code: 'PRIMARY_FEED_STALE',
    };
  }
  return {
    ok: false,
    reason: snap.block_reason || 'PRIMARY_FEED_NOT_LIVE',
    code: 'PRIMARY_FEED_NOT_LIVE',
  };
}
