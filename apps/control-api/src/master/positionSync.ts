/**
 * Broker position sync — VS-System- / Reader recovery pattern.
 * Reconcile MASTER-managed opens against broker truth after restart or missed ACKs.
 * Copies stop/profit levels; attaches a safety SL via modify when broker left the orphan naked.
 * Never treats a failed list call as an empty book (would wipe local opens).
 * Empty successful lists require 5 consecutive snapshots before dropping local ghosts
 * (VS-System emptyBrokerSnapshots debounce — flaky Capital empty must not wipe).
 * Missing tickets from a *non-empty* book also require 5 consecutive misses before drop
 * (partial list flakiness must not ghost-wipe a live ticket that briefly vanished).
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
  /** Re-applied structure SL/TP after mid-life strip (before soft safety). */
  intended_levels_attached: number;
  skipped: boolean;
  skip_reason: string | null;
  /** True when empty book debounce deferred ghost wipe */
  ghost_drop_deferred: boolean;
  orphans_broker: BrokerPosition[];
  orphans_local: ManagedPosition[];
  external_partials: import('./positionManager.js').ExternalPartialEvent[];
};

/** Mutable debounce counter — hold on MasterRuntime across ticks. */
export type EmptyBrokerDebounce = {
  consecutive_empty: number;
  /** Per-position miss counts when broker book is non-empty but ticket absent. */
  miss_by_id?: Record<string, number>;
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
  debounce?: EmptyBrokerDebounce,
  live?: {
    live_regime?: string | null;
    live_analysis?: {
      regime?: string;
      trend_dir?: string;
      structure_bias?: string;
    } | null;
  }
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
      intended_levels_attached: 0,
      skipped: true,
      skip_reason: listed.detail || 'list_failed',
      ghost_drop_deferred: false,
      orphans_broker: [],
      orphans_local: [],
      external_partials: [],
    };
  }

  const brokerPositions = listed.positions;
  const presenceIds = new Set(
    (listed.presence_ids?.length
      ? listed.presence_ids
      : brokerPositions.map((p) => p.position_id)
    ).filter(Boolean)
  );
  const local = manager.list();

  // Full-empty book with local opens → debounce ghost wipe (VS-System ×5)
  // Use presence (incl. level-less deals) so a live deal without open_level
  // is never treated as an empty book.
  if (presenceIds.size === 0 && local.length > 0) {
    const n = (debounce?.consecutive_empty ?? 0) + 1;
    if (debounce) debounce.consecutive_empty = n;
    if (n < EMPTY_BROKER_GHOST_DEBOUNCE) {
      return {
        broker_count: presenceIds.size,
        local_count_before: before,
        local_count_after: before,
        adopted: 0,
        dropped: 0,
        matched: 0,
        safety_sl_attached: 0,
        intended_levels_attached: 0,
        skipped: false,
        skip_reason: `empty_broker_debounce_${n}/${EMPTY_BROKER_GHOST_DEBOUNCE}`,
        ghost_drop_deferred: true,
        orphans_broker: [],
        orphans_local: [],
        external_partials: [],
      };
    }
  } else if (debounce) {
    debounce.consecutive_empty = 0;
  }

  const brokerIds = presenceIds;
  const localIds = new Set(local.map((p) => p.position_id));

  const orphans_broker = brokerPositions.filter((p) => !localIds.has(p.position_id));

  // Per-ticket miss debounce when book is non-empty; full empty uses consecutive_empty above
  const retainIds = new Set<string>();
  let partialGhostDeferred = false;
  let orphans_local: ManagedPosition[] = [];
  if (presenceIds.size > 0) {
    if (debounce && !debounce.miss_by_id) debounce.miss_by_id = {};
    const miss = debounce?.miss_by_id;
    for (const p of local) {
      if (brokerIds.has(p.position_id)) {
        if (miss) delete miss[p.position_id];
        // Level-less live deal: in presence_ids but not positions[] — retain local
        // so reconcileFromBroker does not wipe managed ownership.
        // Keep last local SL/TP for protective marks; chart still unproven so
        // close_requires_sl blocks soft closes (brokerFound + null brokerStop).
        if (!brokerPositions.some((bp) => bp.position_id === p.position_id)) {
          retainIds.add(p.position_id);
          const managed = manager.get(p.position_id);
          if (
            managed &&
            broker.name === 'CAPITAL' &&
            !(broker as { paper?: boolean }).paper
          ) {
            // Presence-only has no venue UPL — disarm money trails like list-fail
            managed.broker_upl = null;
            managed.soft_trail_armed_at = null;
            managed.soft_trail_peak = null;
            managed.native_trail_armed = false;
          }
        }
        continue;
      }
      const n = (miss?.[p.position_id] ?? 0) + 1;
      if (miss) miss[p.position_id] = n;
      if (n < EMPTY_BROKER_GHOST_DEBOUNCE) {
        retainIds.add(p.position_id);
        partialGhostDeferred = true;
      } else {
        orphans_local.push(p);
        if (miss) delete miss[p.position_id];
      }
    }
  } else if (
    (debounce?.consecutive_empty ?? EMPTY_BROKER_GHOST_DEBOUNCE) >=
      EMPTY_BROKER_GHOST_DEBOUNCE ||
    local.length === 0
  ) {
    orphans_local = local.filter((p) => !brokerIds.has(p.position_id));
    if (debounce?.miss_by_id) debounce.miss_by_id = {};
  }
  const matched = brokerPositions.filter((p) => localIds.has(p.position_id)).length;

  const reconcile = manager.reconcileFromBroker(
    brokerPositions.map((p) => ({
      position_id: p.position_id,
      epic: p.epic,
      side: p.side,
      size: p.size,
      open_level: p.open_level,
      open_level_proven: p.open_level_proven,
      stop_level: p.stop_level,
      profit_level: p.profit_level,
      upl: p.upl,
      opened_at: p.opened_at,
    })),
    {
      ...(retainIds.size > 0 ? { retainIds } : {}),
      capitalLive: broker.name === 'CAPITAL' && !(broker as { paper?: boolean }).paper,
      live_regime: live?.live_regime,
      live_analysis: live?.live_analysis,
    }
  );

  let safety_sl_attached = 0;
  let intended_levels_attached = 0;
  if (broker.modifyPosition) {
    // Mid-life strip: prefer re-attaching OPEN structure levels before soft safety cushion.
    for (const bp of brokerPositions) {
      const managed = manager.get(bp.position_id);
      if (!managed) continue;
      const wantSl =
        managed.intended_stop_loss != null &&
        Number.isFinite(managed.intended_stop_loss) &&
        managed.intended_stop_loss > 0
          ? Number(managed.intended_stop_loss)
          : null;
      const wantTp =
        managed.intended_take_profit != null &&
        Number.isFinite(managed.intended_take_profit) &&
        managed.intended_take_profit > 0
          ? Number(managed.intended_take_profit)
          : null;
      const needSl = bp.stop_level == null && wantSl != null;
      const needTp = bp.profit_level == null && wantTp != null;
      if (needSl || needTp) {
        const mod = await broker.modifyPosition({
          position_id: bp.position_id,
          stop_level: needSl
            ? wantSl!
            : bp.stop_level != null
              ? bp.stop_level
              : undefined,
          profit_level: needTp
            ? wantTp!
            : bp.profit_level != null
              ? bp.profit_level
              : undefined,
        });
        if (mod.ok) {
          if (needSl) managed.stop_loss = wantSl;
          if (needTp) managed.take_profit = wantTp;
          intended_levels_attached += 1;
          continue;
        }
        // Intended MODIFY failed this tick — fall through to soft if still naked
      }
      // Soft safety when still naked (including after intended reject this tick)
      if (bp.stop_level != null) continue;
      if (managed.stop_loss != null) continue;
      // Prefer local proven entry — never attach safety geometry from provisional mid
      const safetyAnchor =
        managed.entry > 0 && Number.isFinite(managed.entry)
          ? managed.entry
          : bp.open_level_proven !== false
            ? bp.open_level
            : null;
      if (safetyAnchor == null || !(safetyAnchor > 0)) continue;
      const stop = safetyStopLevel(bp.side, safetyAnchor);
      const soft = await broker.modifyPosition({
        position_id: bp.position_id,
        stop_level: stop,
      });
      if (soft.ok) {
        managed.stop_loss = stop;
        safety_sl_attached += 1;
      }
    }

    // Presence-only locals (level-less, not in positions[]) — still try intended/safety MODIFY
    for (const id of presenceIds) {
      if (brokerPositions.some((bp) => bp.position_id === id)) continue;
      const managed = manager.get(id);
      if (!managed) continue;
      const wantSl =
        managed.intended_stop_loss != null &&
        Number.isFinite(managed.intended_stop_loss) &&
        managed.intended_stop_loss > 0
          ? Number(managed.intended_stop_loss)
          : null;
      const wantTp =
        managed.intended_take_profit != null &&
        Number.isFinite(managed.intended_take_profit) &&
        managed.intended_take_profit > 0
          ? Number(managed.intended_take_profit)
          : null;
      if (wantSl != null || wantTp != null) {
        const mod = await broker.modifyPosition({
          position_id: id,
          stop_level: wantSl ?? undefined,
          profit_level: wantTp ?? undefined,
        });
        if (mod.ok) {
          if (wantSl != null) managed.stop_loss = wantSl;
          if (wantTp != null) managed.take_profit = wantTp;
          intended_levels_attached += 1;
          continue;
        }
      }
      if (managed.stop_loss != null) continue;
      const entry =
        Number.isFinite(managed.entry) && managed.entry > 0
          ? managed.entry
          : null;
      if (entry == null) continue;
      const stop = safetyStopLevel(managed.side, entry);
      const soft = await broker.modifyPosition({
        position_id: id,
        stop_level: stop,
      });
      if (soft.ok) {
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
    broker_count: presenceIds.size,
    local_count_before: before,
    local_count_after: manager.count(),
    adopted: orphans_broker.length,
    dropped: orphans_local.length,
    matched,
    safety_sl_attached,
    intended_levels_attached,
    skipped: false,
    skip_reason: partialGhostDeferred
      ? `partial_ghost_debounce/${EMPTY_BROKER_GHOST_DEBOUNCE}`
      : null,
    ghost_drop_deferred: partialGhostDeferred,
    orphans_broker,
    orphans_local,
    external_partials: reconcile.external_partials,
  };
}
