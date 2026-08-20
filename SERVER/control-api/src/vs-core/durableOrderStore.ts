/**
 * Durable order/intent store — production money path.
 * In-memory OrderStore is TEST ONLY; this persists SUBMITTING+ state across restarts.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import {
  OrderStore,
  transitionOrder,
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
    | 'CLOSE_PENDING'
    | 'POSITION_CLOSED'
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
  'CLOSE_PENDING',
];

export class DurableOrderStore extends OrderStore {
  private ledger = new Map<string, SubmissionLedgerRow>();
  private filePath: string;
  private loadError: string | null = null;
  private loading = false;

  constructor(filePath: string) {
    super();
    this.filePath = filePath;
    this.load();
  }

  /** Non-null when durable file existed but failed to parse — FAIL CLOSED signal. */
  getLoadError(): string | null {
    return this.loadError;
  }

  private load(): void {
    this.loadError = null;
    try {
      if (!existsSync(this.filePath)) return;
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as PersistShape;
      if (!raw || typeof raw !== 'object') {
        this.loadError = 'DURABLE_CORRUPT: root not object';
        return;
      }
      this.loading = true;
      for (const o of raw.orders || []) this.put(o);
      for (const L of raw.ledger || []) this.ledger.set(L.client_order_id, L);
      this.loading = false;
    } catch (e) {
      this.loading = false;
      this.loadError = `DURABLE_CORRUPT: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  private persist(): void {
    if (this.loading) return;
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
        L.state === 'BROKER_ACCEPTED' ||
        L.state === 'CLOSE_PENDING'
    );
  }

  isClosePending(accountId: number, epic: string): boolean {
    return [...this.ledger.values()].some(
      (L) =>
        L.account_id === accountId &&
        L.epic === epic &&
        L.state === 'CLOSE_PENDING'
    );
  }

  /** Allow close retry after stuck CLOSE_PENDING — restore POSITION_OPEN on ledger. */
  clearClosePending(accountId: number, epic: string): number {
    let n = 0;
    for (const L of [...this.ledger.values()]) {
      if (L.account_id === accountId && L.epic === epic && L.state === 'CLOSE_PENDING') {
        this.updateLedger(L.client_order_id, { state: 'POSITION_OPEN' });
        n += 1;
      }
    }
    return n;
  }

  listClosePending(): SubmissionLedgerRow[] {
    return [...this.ledger.values()].filter((L) => L.state === 'CLOSE_PENDING');
  }

  /**
   * Persist CLOSE_PENDING so restart does not lose close-in-progress.
   * Idempotent for account+epic.
   */
  markClosePending(input: {
    account_id: number;
    epic: string;
    client_id?: number;
    direction?: 'BUY' | 'SELL';
    deal_id?: string | null;
    deal_reference?: string | null;
    detail?: string;
  }): SubmissionLedgerRow {
    const existing = [...this.ledger.values()].find(
      (L) =>
        L.account_id === input.account_id &&
        L.epic === input.epic &&
        (L.state === 'POSITION_OPEN' || L.state === 'CLOSE_PENDING')
    );
    if (existing) {
      this.updateLedger(existing.client_order_id, {
        state: 'CLOSE_PENDING',
        deal_id: input.deal_id ?? existing.deal_id,
        deal_reference: input.deal_reference ?? existing.deal_reference,
      });
      return this.getLedger(existing.client_order_id)!;
    }
    const id = `close_${input.account_id}_${input.epic}_${Date.now()}`;
    return this.beginSubmission({
      client_order_id: id,
      intent_id: id,
      setup_id: input.detail || 'close_pending',
      client_id: input.client_id ?? 0,
      account_id: input.account_id,
      epic: input.epic,
      direction: input.direction || 'BUY',
      size: 0,
      state: 'CLOSE_PENDING',
      deal_reference: input.deal_reference ?? null,
      deal_id: input.deal_id ?? null,
    });
  }

  /**
   * Mark open POSITION_OPEN / CLOSE_PENDING as POSITION_CLOSED after broker flat.
   * Idempotent.
   */
  markPositionClosed(accountId: number, epic: string, detail?: string): number {
    let n = 0;
    for (const order of this.openIntents(accountId, epic)) {
      if (order.state !== 'POSITION_OPEN') continue;
      try {
        const closed = transitionOrder(order, 'POSITION_CLOSED', detail);
        this.put(closed);
        this.updateLedger(order.client_order_id, { state: 'POSITION_CLOSED' });
        n += 1;
      } catch {
        /* illegal transition — leave as-is */
      }
    }
    for (const L of [...this.ledger.values()]) {
      if (
        L.account_id === accountId &&
        L.epic === epic &&
        (L.state === 'POSITION_OPEN' || L.state === 'CLOSE_PENDING')
      ) {
        this.updateLedger(L.client_order_id, { state: 'POSITION_CLOSED' });
        n += 1;
      }
    }
    return n;
  }

  /**
   * Capital is flat on this epic — drop SUBMITTING/BROKER_ACCEPTED/POSITION_OPEN ghosts
   * so RISK_REJECTED_DUPLICATE_INTENT cannot freeze SCAN forever.
   */
  override releaseGhostIntents(accountId: number, epic: string): number {
    const n = super.releaseGhostIntents(accountId, epic);
    let extra = 0;
    for (const L of [...this.ledger.values()]) {
      if (L.account_id !== accountId || L.epic !== epic) continue;
      if (!OPEN_LEDGER.includes(L.state)) continue;
      this.updateLedger(L.client_order_id, {
        state: L.state === 'POSITION_OPEN' || L.state === 'CLOSE_PENDING' ? 'POSITION_CLOSED' : 'REJECTED',
      });
      extra += 1;
    }
    return n + extra;
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
