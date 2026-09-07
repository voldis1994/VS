/**
 * Broker position sync — VS-System- / Reader recovery pattern.
 * Reconcile MASTER-managed opens against broker truth after restart or missed ACKs.
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
  orphans_broker: BrokerPosition[];
  orphans_local: ManagedPosition[];
};

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
    }))
  );

  return {
    broker_count: brokerPositions.length,
    local_count_before: before,
    local_count_after: manager.count(),
    adopted: orphans_broker.length,
    dropped: orphans_local.length,
    matched,
    orphans_broker,
    orphans_local,
  };
}
