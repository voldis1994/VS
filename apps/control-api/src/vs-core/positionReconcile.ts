/**
 * Position Core — broker is source of truth. Local vs broker mismatch → reconcile.
 */

export type LocalPosition = {
  account_id: number;
  client_id: number;
  epic: string;
  direction: 'BUY' | 'SELL';
  deal_id: string | null;
  size: number;
};

export type BrokerPosition = {
  epic: string;
  direction: 'BUY' | 'SELL';
  deal_id: string;
  size: number;
  open_level?: number | null;
};

export type ReconcileResult = {
  clean: boolean;
  code: 'RECONCILE_OK' | 'POSITION_STATE_MISMATCH';
  mismatches: Array<{
    epic: string;
    local: LocalPosition | null;
    broker: BrokerPosition | null;
    detail: string;
  }>;
  /** Adopted broker truth for local state repair suggestions. */
  adopted: BrokerPosition[];
};

export function reconcilePositions(
  local: LocalPosition[],
  broker: BrokerPosition[],
  accountId: number
): ReconcileResult {
  const localForAccount = local.filter((p) => p.account_id === accountId);
  const mismatches: ReconcileResult['mismatches'] = [];
  const brokerByEpic = new Map(broker.map((b) => [b.epic, b]));
  const localByEpic = new Map(localForAccount.map((l) => [l.epic, l]));

  for (const [epic, b] of brokerByEpic) {
    const l = localByEpic.get(epic);
    if (!l) {
      mismatches.push({
        epic,
        local: null,
        broker: b,
        detail: `Broker has ${b.direction} deal=${b.deal_id}; local missing`,
      });
      continue;
    }
    if (l.direction !== b.direction) {
      mismatches.push({
        epic,
        local: l,
        broker: b,
        detail: `Direction mismatch local=${l.direction} broker=${b.direction}`,
      });
    } else if (l.deal_id && b.deal_id && l.deal_id !== b.deal_id) {
      mismatches.push({
        epic,
        local: l,
        broker: b,
        detail: `deal_id mismatch local=${l.deal_id} broker=${b.deal_id}`,
      });
    }
  }

  for (const [epic, l] of localByEpic) {
    if (!brokerByEpic.has(epic)) {
      mismatches.push({
        epic,
        local: l,
        broker: null,
        detail: `Local has ${l.direction}; broker flat`,
      });
    }
  }

  return {
    clean: mismatches.length === 0,
    code: mismatches.length === 0 ? 'RECONCILE_OK' : 'POSITION_STATE_MISMATCH',
    mismatches,
    adopted: broker,
  };
}
