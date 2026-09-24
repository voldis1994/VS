/**
 * Closed-trade ledger — persist every desk/pipeline/external close with
 * attribution so expectancy can be measured (regime / setup / exit reason).
 *
 * Does NOT gate entries. Lot size stays operator-chosen.
 */
import { pool } from '../db/pool.js';
import { favorableMove, type ExitSide } from './exitManage.js';

export type TradeLedgerSource = 'desk' | 'pipeline' | 'external';

export type ClosedTradeRecord = {
  broker_account_id: number;
  connection_id: number;
  epic: string;
  direction: ExitSide;
  entry_price: number;
  exit_price: number | null;
  exit_mid: number | null;
  quantity: number;
  /** Account-currency PnL when known (e.g. broker UPL); else null */
  pnl: number | null;
  /** Price-point favorable move at exit (BUY: exit−entry) */
  pnl_pts: number | null;
  exit_reason: string;
  regime: string | null;
  setup_type: string | null;
  mfe: number;
  mae: number;
  peak_retention: number | null;
  hold_ms: number | null;
  source: TradeLedgerSource;
  robot_id: string | null;
  opened_at: string | Date | null;
  position_id?: number | null;
};

export type ExpectancyBucket = {
  key: string;
  trades: number;
  wins: number;
  losses: number;
  scratches: number;
  win_rate: number;
  sum_pnl_pts: number;
  avg_pnl_pts: number;
  expectancy_pts: number;
  avg_win_pts: number;
  avg_loss_pts: number;
  profit_factor: number | null;
  avg_mfe: number;
  avg_mae: number;
  avg_hold_ms: number;
};

export type ExpectancyReport = {
  window: string;
  since: string | null;
  total: ExpectancyBucket;
  by_regime: ExpectancyBucket[];
  by_setup: ExpectancyBucket[];
  by_exit_reason: ExpectancyBucket[];
  by_epic: ExpectancyBucket[];
  sample_size: number;
};

export type ExpectancyTradeRow = {
  pnl_pts: number | null;
  pnl: number | null;
  regime: string | null;
  setup_type: string | null;
  exit_reason: string | null;
  epic: string | null;
  mfe: number | null;
  mae: number | null;
  hold_ms: number | null;
};

const EPS = 1e-9;

export function normalizeDirection(side: string | null | undefined): ExitSide {
  const s = String(side || '')
    .trim()
    .toUpperCase();
  if (s === 'LONG' || s === 'BUY') return 'BUY';
  return 'SELL';
}

export function computePnlPts(
  side: ExitSide,
  entry: number,
  exitMid: number | null | undefined
): number | null {
  if (exitMid == null || !Number.isFinite(exitMid) || !Number.isFinite(entry)) return null;
  return favorableMove(side, entry, exitMid);
}

export function emptyBucket(key: string): ExpectancyBucket {
  return {
    key,
    trades: 0,
    wins: 0,
    losses: 0,
    scratches: 0,
    win_rate: 0,
    sum_pnl_pts: 0,
    avg_pnl_pts: 0,
    expectancy_pts: 0,
    avg_win_pts: 0,
    avg_loss_pts: 0,
    profit_factor: null,
    avg_mfe: 0,
    avg_mae: 0,
    avg_hold_ms: 0,
  };
}

function resolvePts(t: ExpectancyTradeRow): number | null {
  if (t.pnl_pts != null && Number.isFinite(Number(t.pnl_pts))) return Number(t.pnl_pts);
  if (t.pnl != null && Number.isFinite(Number(t.pnl))) return Number(t.pnl);
  return null;
}

/** Pure aggregator — unit-tested without Postgres. */
export function computeExpectancy(
  trades: ExpectancyTradeRow[],
  opts?: { window?: string; since?: string | null }
): ExpectancyReport {
  const byRegime = new Map<string, ExpectancyTradeRow[]>();
  const bySetup = new Map<string, ExpectancyTradeRow[]>();
  const byReason = new Map<string, ExpectancyTradeRow[]>();
  const byEpic = new Map<string, ExpectancyTradeRow[]>();

  for (const t of trades) {
    const regime = (t.regime || 'UNKNOWN').toUpperCase();
    const setup = (t.setup_type || 'NONE').toUpperCase();
    const reason = summarizeExitReason(t.exit_reason);
    const epic = t.epic || 'UNKNOWN';
    pushMap(byRegime, regime, t);
    pushMap(bySetup, setup, t);
    pushMap(byReason, reason, t);
    pushMap(byEpic, epic, t);
  }

  return {
    window: opts?.window || 'all',
    since: opts?.since ?? null,
    total: bucketFromRows('ALL', trades),
    by_regime: mapToBuckets(byRegime),
    by_setup: mapToBuckets(bySetup),
    by_exit_reason: mapToBuckets(byReason),
    by_epic: mapToBuckets(byEpic),
    sample_size: trades.length,
  };
}

function pushMap(m: Map<string, ExpectancyTradeRow[]>, key: string, t: ExpectancyTradeRow) {
  const list = m.get(key);
  if (list) list.push(t);
  else m.set(key, [t]);
}

function mapToBuckets(m: Map<string, ExpectancyTradeRow[]>): ExpectancyBucket[] {
  return [...m.entries()]
    .map(([k, rows]) => bucketFromRows(k, rows))
    .sort((a, b) => b.sum_pnl_pts - a.sum_pnl_pts);
}

export function summarizeExitReason(reason: string | null | undefined): string {
  const r = String(reason || 'UNKNOWN');
  if (/HardInvalidation|HardInv/i.test(r)) return 'HardInvalidation';
  if (/StructureInvalidation|Structure/i.test(r)) return 'StructureInvalidation';
  if (/PeakProtect|PeakProtection/i.test(r)) return 'PeakProtection';
  if (/TimeDecay/i.test(r)) return 'TimeDecay';
  if (/Target/i.test(r)) return 'Target';
  if (/EXTERNAL|broker flat|ghost/i.test(r)) return 'External';
  if (/BE-lock|BE lock/i.test(r)) return 'BE-lock';
  const head = r.split('·')[0]?.trim() || r;
  return head.slice(0, 48) || 'UNKNOWN';
}

export function bucketFromRows(key: string, rows: ExpectancyTradeRow[]): ExpectancyBucket {
  const b = emptyBucket(key);
  let winSum = 0;
  let lossSum = 0;
  let mfeSum = 0;
  let maeSum = 0;
  let holdSum = 0;
  let holdN = 0;

  for (const t of rows) {
    const pts = resolvePts(t);
    b.trades += 1;
    if (pts == null) {
      b.scratches += 1;
      continue;
    }
    b.sum_pnl_pts += pts;
    if (pts > EPS) {
      b.wins += 1;
      winSum += pts;
    } else if (pts < -EPS) {
      b.losses += 1;
      lossSum += pts;
    } else {
      b.scratches += 1;
    }
    if (t.mfe != null && Number.isFinite(Number(t.mfe))) mfeSum += Number(t.mfe);
    if (t.mae != null && Number.isFinite(Number(t.mae))) maeSum += Number(t.mae);
    if (t.hold_ms != null && Number.isFinite(Number(t.hold_ms))) {
      holdSum += Number(t.hold_ms);
      holdN += 1;
    }
  }

  const decided = b.wins + b.losses;
  b.win_rate = decided > 0 ? b.wins / decided : 0;
  b.avg_pnl_pts = b.trades > 0 ? b.sum_pnl_pts / b.trades : 0;
  b.expectancy_pts = b.avg_pnl_pts;
  b.avg_win_pts = b.wins > 0 ? winSum / b.wins : 0;
  b.avg_loss_pts = b.losses > 0 ? lossSum / b.losses : 0;
  const grossWin = winSum;
  const grossLossAbs = Math.abs(lossSum);
  b.profit_factor = null;
  if (grossLossAbs > EPS) b.profit_factor = grossWin / grossLossAbs;
  // JSON cannot carry Infinity — use null and let UI treat "wins only" via losses===0
  else if (grossWin > 0) b.profit_factor = null;
  b.avg_mfe = b.trades > 0 ? mfeSum / b.trades : 0;
  b.avg_mae = b.trades > 0 ? maeSum / b.trades : 0;
  b.avg_hold_ms = holdN > 0 ? holdSum / holdN : 0;
  return b;
}

export function parseExpectancyWindow(raw: string | undefined): {
  window: string;
  since: Date | null;
} {
  const w = String(raw || '30d')
    .trim()
    .toLowerCase();
  const now = Date.now();
  if (w === 'all') return { window: 'all', since: null };
  if (w === '24h' || w === '1d') return { window: '24h', since: new Date(now - 24 * 3600_000) };
  if (w === '7d') return { window: '7d', since: new Date(now - 7 * 24 * 3600_000) };
  if (w === '90d') return { window: '90d', since: new Date(now - 90 * 24 * 3600_000) };
  return { window: '30d', since: new Date(now - 30 * 24 * 3600_000) };
}

/** Persist one closed trade. Best-effort — never throws to callers who catch. */
export async function recordClosedTrade(input: ClosedTradeRecord): Promise<number | null> {
  const direction = normalizeDirection(input.direction);
  const entry = Number(input.entry_price);
  if (!Number.isFinite(entry) || !input.broker_account_id) return null;

  let instrumentId = 0;
  try {
    const m = await pool.query(
      `SELECT id FROM capital_markets
       WHERE broker_connection_id = $1 AND epic = $2 LIMIT 1`,
      [input.connection_id, input.epic]
    );
    instrumentId = Number(m.rows[0]?.id) || 0;
  } catch {
    instrumentId = 0;
  }

  let positionId: number | null = input.position_id ?? null;
  if (positionId == null) {
    try {
      const p = await pool.query(
        `UPDATE positions SET status = 'CLOSED', closed_at = NOW(),
            mfe = COALESCE($4, mfe), mae = COALESCE($5, mae),
            peak_retention = COALESCE($6, peak_retention)
         WHERE broker_account_id = $1 AND status = 'OPEN'
           AND instrument_id IN (
             SELECT id FROM capital_markets WHERE broker_connection_id = $2 AND epic = $3
           )
         RETURNING id`,
        [
          input.broker_account_id,
          input.connection_id,
          input.epic,
          input.mfe,
          input.mae,
          input.peak_retention,
        ]
      );
      positionId = p.rows[0]?.id != null ? Number(p.rows[0].id) : null;
    } catch {
      positionId = null;
    }
  }

  const exitMid = input.exit_mid;
  const pnlPts =
    input.pnl_pts != null && Number.isFinite(input.pnl_pts)
      ? input.pnl_pts
      : computePnlPts(direction, entry, exitMid);
  const exitPrice =
    input.exit_price != null && Number.isFinite(input.exit_price)
      ? input.exit_price
      : exitMid;
  const openedAt = input.opened_at ? new Date(input.opened_at) : new Date();
  const closedAt = new Date();

  const { rows } = await pool.query(
    `INSERT INTO trades (
       position_id, broker_account_id, instrument_id, direction,
       entry_price, exit_price, quantity, pnl, exit_reason, regime,
       opened_at, closed_at,
       epic, setup_type, mfe, mae, peak_retention, hold_ms,
       pnl_pts, exit_mid, source, robot_id
     ) VALUES (
       $1,$2,$3,$4,
       $5,$6,$7,$8,$9,$10,
       $11,$12,
       $13,$14,$15,$16,$17,$18,
       $19,$20,$21,$22
     ) RETURNING id`,
    [
      positionId,
      input.broker_account_id,
      instrumentId,
      direction === 'BUY' ? 'LONG' : 'SHORT',
      entry,
      exitPrice,
      input.quantity,
      input.pnl,
      String(input.exit_reason || '').slice(0, 200),
      input.regime ? String(input.regime).slice(0, 50) : null,
      openedAt,
      closedAt,
      input.epic ? String(input.epic).slice(0, 100) : null,
      input.setup_type ? String(input.setup_type).slice(0, 50) : null,
      input.mfe,
      input.mae,
      input.peak_retention,
      input.hold_ms,
      pnlPts,
      exitMid,
      input.source,
      input.robot_id,
    ]
  );
  return rows[0]?.id != null ? Number(rows[0].id) : null;
}

export async function fetchExpectancyReport(opts: {
  window?: string;
  client_id?: string;
  account_id?: string;
  epic?: string;
}): Promise<ExpectancyReport> {
  const { window, since } = parseExpectancyWindow(opts.window);
  let sql = `
    SELECT t.pnl_pts, t.pnl, t.regime, t.setup_type, t.exit_reason, t.epic,
           t.mfe, t.mae, t.hold_ms
    FROM trades t
    JOIN broker_accounts ba ON ba.id = t.broker_account_id
    JOIN broker_connections bc ON bc.id = ba.broker_connection_id
    WHERE t.closed_at IS NOT NULL`;
  const params: unknown[] = [];
  let idx = 1;
  if (since) {
    sql += ` AND t.closed_at >= $${idx++}`;
    params.push(since.toISOString());
  }
  if (opts.client_id) {
    sql += ` AND bc.client_id = $${idx++}`;
    params.push(opts.client_id);
  }
  if (opts.account_id) {
    sql += ` AND t.broker_account_id = $${idx++}`;
    params.push(opts.account_id);
  }
  if (opts.epic) {
    sql += ` AND t.epic = $${idx++}`;
    params.push(opts.epic);
  }
  sql += ` ORDER BY t.closed_at DESC LIMIT 5000`;

  const { rows } = await pool.query(sql, params);
  return computeExpectancy(rows as ExpectancyTradeRow[], {
    window,
    since: since ? since.toISOString() : null,
  });
}
