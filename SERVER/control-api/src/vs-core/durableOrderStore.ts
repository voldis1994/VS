/**
 * Durable order/intent store — production money path.
 * In-memory OrderStore is TEST ONLY; this persists SUBMITTING+ state across restarts.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import {
  OrderStore,
  type OrderRecord,
  type OrderState,
} from './orderStateMachine.js';

export type SubmissionLedgerRow = {
  client_order_id: string;
  intent_id: string;
  setup_id: string;
  client_id: number;
  account_id: number;
  epic: string;
  direction: 'BUY' | 'SELL';
  size: number;
  state:
    | 'SUBMITTING'
    | 'BROKER_ACCEPTED'
    | 'BROKER_RESULT_UNRESOLVED'
    | 'FILLED'
    | 'POSITION_OPEN'
    | 'REJECTED';
  deal_reference: string | null;
  deal_id: string | null;
  created_at: string;
  updated_at: string;
};

type PersistShape = {
  orders: OrderRecord[];
  ledger: SubmissionLedgerRow[];
};

const OPEN_LEDGER: SubmissionLedgerRow['state'][] = [
  'SUBMITTING',
  'BROKER_ACCEPTED',
  'BROKER_RESULT_UNRESOLVED',
  'FILLED',
  'POSITION_OPEN',
];

export class DurableOrderStore extends OrderStore {
  private ledger = new Map<string, SubmissionLedgerRow>();
  private filePath: string;

  constructor(filePath: string) {
    super();
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(this.filePath)) return;
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as PersistShape;
      for (const o of raw.orders || []) this.put(o);
      for (const L of raw.ledger || []) this.ledger.set(L.client_order_id, L);
    } catch {
      /* corrupt → start empty; caller should raise incident */
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const all = this.listAll();
    const payload: PersistShape = {
      orders: all,
      ledger: [...this.ledger.values()],
    };
    writeFileSync(this.filePath, JSON.stringify(payload, null, 2));
  }

  listAll(): OrderRecord[] {
    return super.listAll();
  }

  override put(order: OrderRecord): void {
    super.put(order);
    this.persist();
  }

  beginSubmission(row: Omit<SubmissionLedgerRow, 'created_at' | 'updated_at' | 'state'> & {
    state?: SubmissionLedgerRow['state'];
  }): SubmissionLedgerRow {
    const now = new Date().toISOString();
    const full: SubmissionLedgerRow = {
      ...row,
      state: row.state || 'SUBMITTING',
      deal_reference: row.deal_reference ?? null,
      deal_id: row.deal_id ?? null,
      created_at: now,
      updated_at: now,
    };
    this.ledger.set(full.client_order_id, full);
    this.persist();
    return full;
  }

  updateLedger(
    clientOrderId: string,
    patch: Partial<Pick<SubmissionLedgerRow, 'state' | 'deal_reference' | 'deal_id'>>
  ): void {
    const cur = this.ledger.get(clientOrderId);
    if (!cur) return;
    this.ledger.set(clientOrderId, {
      ...cur,
      ...patch,
      updated_at: new Date().toISOString(),
    });
    this.persist();
  }

  getLedger(clientOrderId: string): SubmissionLedgerRow | undefined {
    return this.ledger.get(clientOrderId);
  }

  /** Open/unresolved submissions for account+epic — blocks duplicate money path. */
  openLedger(accountId: number, epic: string): SubmissionLedgerRow[] {
    return [...this.ledger.values()].filter(
      (L) => L.account_id === accountId && L.epic === epic && OPEN_LEDGER.includes(L.state)
    );
  }

  hasUnresolvedSubmission(accountId: number, epic: string): boolean {
    return this.openLedger(accountId, epic).some(
      (L) =>
        L.state === 'SUBMITTING' ||
        L.state === 'BROKER_RESULT_UNRESOLVED' ||
        L.state === 'BROKER_ACCEPTED'
    );
  }
}

let shared: DurableOrderStore | null = null;

export function getDurableOrderStore(dataRoot?: string): DurableOrderStore {
  if (!shared) {
    const root = dataRoot || process.env.VS_CORE_DATA || join(process.cwd(), 'data', 'vs-core');
    shared = new DurableOrderStore(join(root, 'orders', 'durable-orders.json'));
  }
  return shared;
}

export function resetDurableOrderStoreForTests(filePath?: string): DurableOrderStore {
  const path =
    filePath ||
    join(process.env.TMPDIR || '/tmp', `vs-orders-test-${Date.now()}.json`);
  shared = new DurableOrderStore(path);
  return shared;
}

export function isOpenOrderState(state: OrderState): boolean {
  return [
    'SIGNAL_CREATED',
    'RISK_ACCEPTED',
    'ORDER_CREATED',
    'SUBMITTING',
    'BROKER_RESULT_UNRESOLVED',
    'BROKER_ACCEPTED',
    'FILLED',
    'PARTIAL_FILL',
    'POSITION_OPEN',
  ].includes(state);
}
