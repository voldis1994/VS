/**
 * Local Excel-friendly trade journal (CSV, UTF-8 BOM, `;` separator for LV Excel).
 * Default path: <repo>/data/exports/VS-trade-journal.csv
 * Override: TRADE_JOURNAL_PATH or TRADE_JOURNAL_DIR
 *
 * One row per CLOSED trade with full open + close context for edge analysis.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** apps/control-api/src/services → repo root */
const REPO_ROOT = path.resolve(__dirname, '../../../../');

export type JournalOpenSnap = {
  trade_id: string;
  source: 'desk' | 'pipeline' | 'manage';
  opened_at: string;
  account_id: number;
  client_id: number;
  client_name: string;
  account_name: string;
  robot_id: string;
  environment: string;
  epic: string;
  display_name: string;
  side: 'BUY' | 'SELL';
  lot_size: number;
  entry_price: number | null;
  safety_sl: number | null;
  deal_id: string | null;
  deal_reference: string | null;
  regime: string;
  setup_type: string | null;
  zone_kind: string | null;
  zone_high: number | null;
  zone_low: number | null;
  zone_detail: string | null;
  open_reason: string;
  feed_source: string | null;
  feed_agreement: string | null;
  feed_contributing: number | null;
  feed_sender_count: number | null;
  lead_label: string | null;
  ohlc_last: string | null;
  entry_enabled: boolean;
};

export type JournalCloseInput = {
  open: JournalOpenSnap;
  closed_at: string;
  exit_price: number | null;
  exit_mid: number | null;
  close_reason: string;
  mfe: number;
  mae: number;
  peak_retention: number | null;
  unrealized_at_close: number | null;
  regime_at_exit: string;
  zone_detail_at_exit: string | null;
  was_loss: boolean;
  hold_sec: number;
  pnl_pts: number | null;
};

const HEADERS = [
  'trade_id',
  'source',
  'opened_at',
  'closed_at',
  'hold_sec',
  'account_id',
  'client_id',
  'client_name',
  'account_name',
  'robot_id',
  'environment',
  'epic',
  'display_name',
  'side',
  'lot_size',
  'entry_price',
  'exit_price',
  'exit_mid',
  'pnl_pts',
  'was_loss',
  'mfe',
  'mae',
  'peak_retention',
  'unrealized_at_close',
  'safety_sl',
  'deal_id',
  'deal_reference',
  'regime_entry',
  'regime_exit',
  'setup_type',
  'zone_kind',
  'zone_low',
  'zone_high',
  'zone_detail',
  'zone_at_exit',
  'open_reason',
  'close_reason',
  'feed_source',
  'feed_agreement',
  'feed_contributing',
  'feed_sender_count',
  'lead_label',
  'ohlc_last',
  'entry_enabled',
] as const;

function sep(): string {
  return process.env.TRADE_JOURNAL_SEP === ',' ? ',' : ';';
}

export function tradeJournalPath(): string {
  if (process.env.TRADE_JOURNAL_PATH) {
    return path.resolve(process.env.TRADE_JOURNAL_PATH);
  }
  const dir = process.env.TRADE_JOURNAL_DIR
    ? path.resolve(process.env.TRADE_JOURNAL_DIR)
    : path.join(REPO_ROOT, 'data', 'exports');
  return path.join(dir, 'VS-trade-journal.csv');
}

function esc(v: string | number | boolean | null | undefined): string {
  if (v == null) return '';
  const s = String(v);
  const d = sep();
  if (s.includes(d) || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function ensureFile(file: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file)) {
    const bom = '\uFEFF';
    fs.writeFileSync(file, bom + HEADERS.join(sep()) + '\n', 'utf8');
  }
}

export function newTradeId(prefix = 'T'): string {
  const t = new Date();
  const stamp = t.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const rnd = Math.floor(Math.random() * 9000 + 1000);
  return `${prefix}-${stamp}-${rnd}`;
}

export function appendClosedTrade(row: JournalCloseInput): { ok: boolean; path: string; detail: string } {
  const file = tradeJournalPath();
  try {
    ensureFile(file);
    const o = row.open;
    const line = [
      o.trade_id,
      o.source,
      o.opened_at,
      row.closed_at,
      row.hold_sec,
      o.account_id,
      o.client_id,
      o.client_name,
      o.account_name,
      o.robot_id,
      o.environment,
      o.epic,
      o.display_name,
      o.side,
      o.lot_size,
      o.entry_price,
      row.exit_price,
      row.exit_mid,
      row.pnl_pts,
      row.was_loss ? 'YES' : 'NO',
      row.mfe,
      row.mae,
      row.peak_retention,
      row.unrealized_at_close,
      o.safety_sl,
      o.deal_id,
      o.deal_reference,
      o.regime,
      row.regime_at_exit,
      o.setup_type,
      o.zone_kind,
      o.zone_low,
      o.zone_high,
      o.zone_detail,
      row.zone_detail_at_exit,
      o.open_reason,
      row.close_reason,
      o.feed_source,
      o.feed_agreement,
      o.feed_contributing,
      o.feed_sender_count,
      o.lead_label,
      o.ohlc_last,
      o.entry_enabled ? 'YES' : 'NO',
    ]
      .map(esc)
      .join(sep());
    fs.appendFileSync(file, line + '\n', 'utf8');
    return { ok: true, path: file, detail: `journal OK · ${file}` };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, path: file, detail: `journal FAIL · ${detail}` };
  }
}

/** Optional open breadcrumb line (analysis of skipped closes / crashes). */
export function appendOpenEvent(open: JournalOpenSnap): { ok: boolean; path: string; detail: string } {
  const file = tradeJournalPath().replace(/\.csv$/i, '') + '-opens.csv';
  try {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const headers = [
      'trade_id',
      'opened_at',
      'source',
      'robot_id',
      'epic',
      'side',
      'entry_price',
      'regime',
      'setup_type',
      'zone_detail',
      'open_reason',
      'feed_source',
      'lead_label',
    ];
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, '\uFEFF' + headers.join(sep()) + '\n', 'utf8');
    }
    const line = [
      open.trade_id,
      open.opened_at,
      open.source,
      open.robot_id,
      open.epic,
      open.side,
      open.entry_price,
      open.regime,
      open.setup_type,
      open.zone_detail,
      open.open_reason,
      open.feed_source,
      open.lead_label,
    ]
      .map(esc)
      .join(sep());
    fs.appendFileSync(file, line + '\n', 'utf8');
    return { ok: true, path: file, detail: `open-log OK · ${file}` };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, path: file, detail: `open-log FAIL · ${detail}` };
  }
}
