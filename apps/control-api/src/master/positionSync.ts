/**
 * Broker position sync — VS-System- / Reader recovery pattern.
 * Reconcile MASTER-managed opens against broker truth after restart or missed ACKs.
 * Copies stop/profit levels; attaches a safety SL via modify when broker left the orphan naked.
 * Never treats a failed list call as an empty book (would wipe local opens).
 * Empty successful lists require 5 consecutive snapshots before dropping local ghosts
 * (VS-System emptyBrokerSnapshots debounce — flaky Capital empty must not wipe).
 */
import type { MasterBroker, BrokerPosition } from './broker.js';
import type { PositionManager, ManagedPosition } from './positionManager.js';
import { SCALP_INITIAL_SL_PCT } from './scalpPctChase.js';

export type SyncReport = {
  broker_count: number;
  local_count_before: number;
  local_count_after: number;
  adopted: number;
  dropped: number;
  matched: number;
  safety_sl_attached: number;
  skipped: boolean;
  skip_reason: string | null;
  /** True when empty book debounce deferred ghost wipe */
  ghost_drop_deferred: boolean;
  orphans_broker: BrokerPosition[];
  orphans_local: ManagedPosition[];
};

/** Mutable debounce counter — hold on MasterRuntime across ticks. */
export type EmptyBrokerDebounce = {
  consecutive_empty: number;
};

/** VS-System: require this many consecutive successful empty lists before ghost wipe. */
export const EMPTY_BROKER_GHOST_DEBOUNCE = 5;

/** SCALP 10%-of-price cushion when adopting a naked orphan (no broker stop). */
export function safetyStopLevel(side: 'BUY' | 'SELL', entry: number): number {
  const e = Number(entry);
  const abs = Number.isFinite(e) && e > 0 ? e : Math.max(Math.abs(e), 1e-9);
  const dist = abs * SCALP_INITIAL_SL_PCT;
  return side === 'BUY' ? entry - dist : entry + dist;
}

export async function syncPositionsWithBroker(
  manager: PositionManager,
  broker: MasterBroker,
  epic?: string,
  debounce?: EmptyBrokerDebounce
): Promise<SyncReport> {
  const before = manager.count();
  const listed = await broker.listOpenPositions(epic);
  if (!listed.ok) {
    return {
      broker_count: 0,
      local_count_before: before,
      local_count_after: before,
      adopted: 0,
      dropped: 0,
      matched: 0,
      safety_sl_attached: 0,
      skipped: true,
      skip_reason: listed.detail || 'list_failed',
      ghost_drop_deferred: false,
      orphans_broker: [],
      orphans_local: [],
    };
  }

  const brokerPositions = listed.positions;
  const local = manager.list();

  // Full-empty book with local opens → debounce ghost wipe (VS-System ×5)
  if (brokerPositions.length === 0 && local.length > 0) {
    const n = (debounce?.consecutive_empty ?? 0) + 1;
    if (debounce) debounce.consecutive_empty = n;
    if (n < EMPTY_BROKER_GHOST_DEBOUNCE) {
      return {
        broker_count: 0,
        local_count_before: before,
        local_count_after: before,
        adopted: 0,
        dropped: 0,
        matched: 0,
        safety_sl_attached: 0,
        skipped: false,
        skip_reason: `empty_broker_debounce_${n}/${EMPTY_BROKER_GHOST_DEBOUNCE}`,
        ghost_drop_deferred: true,
        orphans_broker: [],
        orphans_local: [],
      };
    }
  } else if (debounce) {
    debounce.consecutive_empty = 0;
  }

  const brokerIds = new Set(brokerPositions.map((p) => p.position_id));
  const localIds = new Set(local.map((p) => p.position_id));

  const orphans_broker = brokerPositions.filter((p) => !localIds.has(p.position_id));
  // Missing from a non-empty book, OR confirmed flat after debounce — drop locals
  const orphans_local =
    brokerPositions.length > 0 ||
    (debounce?.consecutive_empty ?? EMPTY_BROKER_GHOST_DEBOUNCE) >= EMPTY_BROKER_GHOST_DEBOUNCE ||
    local.length === 0
      ? local.filter((p) => !brokerIds.has(p.position_id))
      : [];
  const matched = brokerPositions.filter((p) => localIds.has(p.position_id)).length;

  manager.reconcileFromBroker(
    brokerPositions.map((p) => ({
      position_id: p.position_id,
      epic: p.epic,
      side: p.side,
      size: p.size,
      open_level: p.open_level,
      stop_level: p.stop_level,
      profit_level: p.profit_level,
      opened_at: p.opened_at,
    }))
  );

  let safety_sl_attached = 0;
  if (broker.modifyPosition) {
    for (const orphan of orphans_broker) {
      if (orphan.stop_level != null) continue;
      const managed = manager.get(orphan.position_id);
      if (!managed || managed.stop_loss != null) continue;
      const stop = safetyStopLevel(orphan.side, orphan.open_level);
      const mod = await broker.modifyPosition({
        position_id: orphan.position_id,
        stop_level: stop,
      });
      if (mod.ok) {
        managed.stop_loss = stop;
        safety_sl_attached += 1;
      }
    }
  }

  if (debounce && brokerPositions.length === 0) {
    // Confirmed flat after debounce — reset so next empty cycle starts clean
    debounce.consecutive_empty = 0;
  }

  return {
    broker_count: brokerPositions.length,
    local_count_before: before,
    local_count_after: manager.count(),
    adopted: orphans_broker.length,
    dropped: orphans_local.length,
    matched,
    safety_sl_attached,
    skipped: false,
    skip_reason: null,
    ghost_drop_deferred: false,
    orphans_broker,
    orphans_local,
  };
}
