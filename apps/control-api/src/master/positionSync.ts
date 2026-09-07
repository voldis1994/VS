/**
 * Broker position sync — VS-System- / Reader recovery pattern.
 * Reconcile MASTER-managed opens against broker truth after restart or missed ACKs.
 * Copies stop/profit levels; attaches a safety SL via modify when broker left the orphan naked.
 */
import type { MasterBroker, BrokerPosition } from './broker.js';
import type { PositionManager, ManagedPosition } from './positionManager.js';

export type SyncReport = {
  broker_count: number;
  local_count_before: number;
  local_count_after: number;
  adopted: number;
  dropped: number;
  matched: number;
  safety_sl_attached: number;
  orphans_broker: BrokerPosition[];
  orphans_local: ManagedPosition[];
};

/** SCALP-style cushion when adopting a naked orphan (no broker stop). */
export function safetyStopLevel(side: 'BUY' | 'SELL', entry: number): number {
  const abs = Math.max(Math.abs(entry), 1e-9);
  const dist = Math.min(Math.max(abs * 0.0004, 1.2), 2.2);
  return side === 'BUY' ? entry - dist : entry + dist;
}

export async function syncPositionsWithBroker(
  manager: PositionManager,
  broker: MasterBroker,
  epic?: string
): Promise<SyncReport> {
  const brokerPositions = await broker.listOpenPositions(epic);
  const local = manager.list();
  const brokerIds = new Set(brokerPositions.map((p) => p.position_id));
  const localIds = new Set(local.map((p) => p.position_id));

  const orphans_broker = brokerPositions.filter((p) => !localIds.has(p.position_id));
  const orphans_local = local.filter((p) => !brokerIds.has(p.position_id));
  const matched = brokerPositions.filter((p) => localIds.has(p.position_id)).length;
  const before = manager.count();

  manager.reconcileFromBroker(
    brokerPositions.map((p) => ({
      position_id: p.position_id,
      epic: p.epic,
      side: p.side,
      size: p.size,
      open_level: p.open_level,
      stop_level: p.stop_level,
      profit_level: p.profit_level,
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

  return {
    broker_count: brokerPositions.length,
    local_count_before: before,
    local_count_after: manager.count(),
    adopted: orphans_broker.length,
    dropped: orphans_local.length,
    matched,
    safety_sl_attached,
    orphans_broker,
    orphans_local,
  };
}
