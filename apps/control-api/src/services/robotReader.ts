import { pool } from '../db/pool.js';
import { decrypt } from '../security/encryption.js';
import {
  CapitalSession,
  acquireCapitalSession,
  fetchCapitalMarketQuote,
} from './capitalCom.js';
import {
  PUBLIC_SENDERS,
  epicToFxPair,
  fusePriceMids,
  readAllPublicFeeds,
  type PublicFeedRead,
} from './publicInternetFeeds.js';

export { epicToFxPair } from './publicInternetFeeds.js';

export type SenderKind =
  | 'capital_com'
  | 'fx_reference'
  | 'catalog_pulse'
  | 'yahoo_finance'
  | 'aurum_metals'
  | 'fx_live'
  | 'coinbase';

export interface DataSender {
  sender_id: string;
  name: string;
  kind: SenderKind;
  trust: 'broker_live' | 'broker_demo' | 'public_ref' | 'catalog';
  environment?: string;
  connection_id?: number;
  client_name?: string;
  /** Broker connection enabled flag (Capital rows only). */
  enabled?: boolean;
  status: 'LIVE' | 'IDLE' | 'ERROR' | 'STALE';
  last_ok_at: string | null;
  last_error: string | null;
  latency_ms: number | null;
  reads_ok: number;
  reads_fail: number;
}

export interface SenderRead {
  sender_id: string;
  name: string;
  kind: SenderKind;
  epic: string;
  ok: boolean;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  spread: number | null;
  market_status: string | null;
  source_time: string | null;
  latency_ms: number;
  detail?: string;
}

export interface OrbitScanResult {
  scanned_at: string;
  epics: string[];
  senders: DataSender[];
  reads: SenderRead[];
  consensus: Array<{
    epic: string;
    contributing: number;
    mid_avg: number | null;
    mid_span: number | null;
    agreement: 'STRONG' | 'OK' | 'DIVERGENT' | 'INSUFFICIENT';
  }>;
  note: string;
}

const senderHealth = new Map<
  string,
  {
    status: DataSender['status'];
    last_ok_at: string | null;
    last_error: string | null;
    latency_ms: number | null;
    reads_ok: number;
    reads_fail: number;
  }
>();

const FX_REF_ID = 'fx-ref-frankfurter';
const CATALOG_ID = 'catalog-pulse';

async function loadCredentialMap(brokerConnectionId: number): Promise<Record<string, string>> {
  const { rows } = await pool.query(
    `SELECT credential_type, ciphertext, iv, tag
     FROM api_credential_metadata
     WHERE broker_connection_id = $1`,
    [brokerConnectionId]
  );
  const out: Record<string, string> = {};
  for (const row of rows) {
    out[row.credential_type as string] = decrypt(
      row.ciphertext as string,
      row.iv as string,
      row.tag as string
    );
  }
  return out;
}

function touchHealth(
  senderId: string,
  patch: Partial<{
    status: DataSender['status'];
    last_ok_at: string | null;
    last_error: string | null;
    latency_ms: number | null;
    ok: boolean;
  }>
) {
  const prev = senderHealth.get(senderId) || {
    status: 'IDLE' as const,
    last_ok_at: null,
    last_error: null,
    latency_ms: null,
    reads_ok: 0,
    reads_fail: 0,
  };
  if (patch.ok === true) prev.reads_ok += 1;
  if (patch.ok === false) prev.reads_fail += 1;
  if (patch.status) prev.status = patch.status;
  if (patch.last_ok_at !== undefined) prev.last_ok_at = patch.last_ok_at;
  if (patch.last_error !== undefined) prev.last_error = patch.last_error;
  if (patch.latency_ms !== undefined) prev.latency_ms = patch.latency_ms;
  senderHealth.set(senderId, prev);
}

async function getCapitalSession(connectionId: number): Promise<
  | { ok: true; session: CapitalSession }
  | { ok: false; detail: string }
> {
  const { rows } = await pool.query(
    `SELECT id, broker_name, environment, identifier, enabled
     FROM broker_connections WHERE id = $1`,
    [connectionId]
  );
  if (rows.length === 0) return { ok: false, detail: 'Broker connection missing' };
  const conn = rows[0] as {
    broker_name: string;
    environment: string;
    identifier: string | null;
    enabled: boolean;
  };
  if (!conn.enabled) return { ok: false, detail: 'Broker connection disabled' };
  if (conn.broker_name !== 'capital_com') {
    return { ok: false, detail: 'Not a Capital.com connection' };
  }

  const creds = await loadCredentialMap(connectionId);
  const apiKey = creds.api_key || '';
  const password = creds.password || '';
  const identifier = (conn.identifier || '').trim();
  if (!apiKey || !password || !identifier) {
    return { ok: false, detail: 'Missing Capital.com credentials' };
  }

  // Shared pool with Robot Desk — isolated per broker connection (multi-client safe)
  const opened = await acquireCapitalSession({
    environment: conn.environment,
    apiKey,
    identifier,
    password,
    connectionId,
  });
  if (!opened.ok) return { ok: false, detail: opened.result.detail };
  return { ok: true, session: opened.session };
}

export async function listDataSenders(): Promise<DataSender[]> {
  let rows: Array<Record<string, unknown>> = [];
  try {
    const q = await pool.query(
      `SELECT bc.id, bc.broker_name, bc.environment, bc.enabled, bc.identifier,
              c.name as client_name,
              (SELECT COUNT(*)::int FROM capital_markets cm WHERE cm.broker_connection_id = bc.id) as markets
       FROM broker_connections bc
       JOIN clients c ON c.id = bc.client_id
       WHERE bc.broker_name = 'capital_com'
       ORDER BY bc.id ASC`
    );
    rows = q.rows as Array<Record<string, unknown>>;
  } catch {
    // DB down — still return public internet senders so OHLC fusion can run
    rows = [];
  }

  const senders: DataSender[] = rows.map((r) => {
    const sender_id = `capital-${r.id}`;
    const health = senderHealth.get(sender_id);
    const env = String(r.environment || 'demo').toLowerCase();
    let status: DataSender['status'] = health?.status || 'IDLE';
    if (!r.enabled) status = 'IDLE';
    return {
      sender_id,
      name: `${r.client_name} / Capital.com ${env.toUpperCase()}`,
      kind: 'capital_com' as const,
      trust: env === 'live' ? ('broker_live' as const) : ('broker_demo' as const),
      environment: env,
      connection_id: r.id as number,
      client_name: r.client_name as string,
      enabled: Boolean(r.enabled),
      status,
      last_ok_at: health?.last_ok_at ?? null,
      last_error: health?.last_error ?? null,
      latency_ms: health?.latency_ms ?? null,
      reads_ok: health?.reads_ok ?? 0,
      reads_fail: health?.reads_fail ?? 0,
    };
  });

  const fxHealth = senderHealth.get(FX_REF_ID);
  senders.push({
    sender_id: FX_REF_ID,
    name: 'ECB / Frankfurter FX reference',
    kind: 'fx_reference',
    trust: 'public_ref',
    status: fxHealth?.status || 'IDLE',
    last_ok_at: fxHealth?.last_ok_at ?? null,
    last_error: fxHealth?.last_error ?? null,
    latency_ms: fxHealth?.latency_ms ?? null,
    reads_ok: fxHealth?.reads_ok ?? 0,
    reads_fail: fxHealth?.reads_fail ?? 0,
  });

  const catHealth = senderHealth.get(CATALOG_ID);
  senders.push({
    sender_id: CATALOG_ID,
    name: 'Capital catalog pulse (DB)',
    kind: 'catalog_pulse',
    trust: 'catalog',
    status: catHealth?.status || 'IDLE',
    last_ok_at: catHealth?.last_ok_at ?? null,
    last_error: catHealth?.last_error ?? null,
    latency_ms: catHealth?.latency_ms ?? null,
    reads_ok: catHealth?.reads_ok ?? 0,
    reads_fail: catHealth?.reads_fail ?? 0,
  });

  for (const p of PUBLIC_SENDERS) {
    const health = senderHealth.get(p.sender_id);
    senders.push({
      sender_id: p.sender_id,
      name: p.name,
      kind: p.kind,
      trust: 'public_ref',
      enabled: true,
      status: health?.status || 'IDLE',
      last_ok_at: health?.last_ok_at ?? null,
      last_error: health?.last_error ?? null,
      latency_ms: health?.latency_ms ?? null,
      reads_ok: health?.reads_ok ?? 0,
      reads_fail: health?.reads_fail ?? 0,
    });
  }

  return senders;
}

async function readFxReference(epic: string): Promise<SenderRead> {
  const t0 = Date.now();
  const pair = epicToFxPair(epic);
  if (!pair) {
    touchHealth(FX_REF_ID, {
      status: 'IDLE',
      ok: false,
      last_error: 'Not an FX pair — FX reference skipped',
      latency_ms: Date.now() - t0,
    });
    return {
      sender_id: FX_REF_ID,
      name: 'ECB / Frankfurter FX reference',
      kind: 'fx_reference',
      epic,
      ok: false,
      bid: null,
      ask: null,
      mid: null,
      spread: null,
      market_status: null,
      source_time: null,
      latency_ms: Date.now() - t0,
      detail: 'FX reference only applies to major currency pairs',
    };
  }

  try {
    const url = `https://api.frankfurter.app/latest?from=${pair.from}&to=${pair.to}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const json = (await res.json()) as { rates?: Record<string, number>; date?: string };
    const rate = json.rates?.[pair.to];
    const latency_ms = Date.now() - t0;
    if (!res.ok || rate == null || !Number.isFinite(rate)) {
      touchHealth(FX_REF_ID, {
        status: 'ERROR',
        ok: false,
        last_error: `Frankfurter HTTP ${res.status}`,
        latency_ms,
      });
      return {
        sender_id: FX_REF_ID,
        name: 'ECB / Frankfurter FX reference',
        kind: 'fx_reference',
        epic,
        ok: false,
        bid: null,
        ask: null,
        mid: null,
        spread: null,
        market_status: null,
        source_time: json.date || null,
        latency_ms,
        detail: `Frankfurter failed for ${pair.from}/${pair.to}`,
      };
    }

    const now = new Date().toISOString();
    touchHealth(FX_REF_ID, {
      status: 'LIVE',
      ok: true,
      last_ok_at: now,
      last_error: null,
      latency_ms,
    });
    return {
      sender_id: FX_REF_ID,
      name: 'ECB / Frankfurter FX reference',
      kind: 'fx_reference',
      epic,
      ok: true,
      bid: rate,
      ask: rate,
      mid: rate,
      spread: 0,
      market_status: 'DAILY_REF',
      source_time: json.date || now,
      latency_ms,
      detail: `ECB daily mid ${pair.from}/${pair.to} (not a live tick)`,
    };
  } catch (err) {
    const latency_ms = Date.now() - t0;
    const detail = err instanceof Error ? err.message : String(err);
    touchHealth(FX_REF_ID, { status: 'ERROR', ok: false, last_error: detail, latency_ms });
    return {
      sender_id: FX_REF_ID,
      name: 'ECB / Frankfurter FX reference',
      kind: 'fx_reference',
      epic,
      ok: false,
      bid: null,
      ask: null,
      mid: null,
      spread: null,
      market_status: null,
      source_time: null,
      latency_ms,
      detail,
    };
  }
}

async function readCatalogPulse(epic: string): Promise<SenderRead> {
  const t0 = Date.now();
  try {
    const { rows } = await pool.query(
      `SELECT cm.epic, cm.display_name, cm.updated_at, bc.environment, c.name as client_name
       FROM capital_markets cm
       JOIN broker_connections bc ON bc.id = cm.broker_connection_id
       JOIN clients c ON c.id = bc.client_id
       WHERE cm.epic ILIKE $1
          OR cm.symbol ILIKE $1
          OR cm.display_name ILIKE $2
       ORDER BY
         CASE
           WHEN lower(cm.epic) = lower($3) THEN 0
           WHEN lower(cm.symbol) = lower($3) THEN 1
           ELSE 2
         END,
         cm.updated_at DESC
       LIMIT 8`,
      [epic, `%${epic}%`, epic]
    );
    const latency_ms = Date.now() - t0;
    if (rows.length === 0) {
      touchHealth(CATALOG_ID, {
        status: 'ERROR',
        ok: false,
        last_error: 'Epic not in capital_markets — pull markets first',
        latency_ms,
      });
      return {
        sender_id: CATALOG_ID,
        name: 'Capital catalog pulse (DB)',
        kind: 'catalog_pulse',
        epic,
        ok: false,
        bid: null,
        ask: null,
        mid: null,
        spread: null,
        market_status: 'MISSING',
        source_time: null,
        latency_ms,
        detail: 'Epic not found in local Capital catalog. Trading → Pull ALL Capital.com markets.',
      };
    }

    const now = new Date().toISOString();
    touchHealth(CATALOG_ID, {
      status: 'LIVE',
      ok: true,
      last_ok_at: now,
      last_error: null,
      latency_ms,
    });
    const names = rows
      .map((r) => `${r.client_name}/${r.environment}`)
      .slice(0, 3)
      .join(', ');
    return {
      sender_id: CATALOG_ID,
      name: 'Capital catalog pulse (DB)',
      kind: 'catalog_pulse',
      epic,
      ok: true,
      bid: null,
      ask: null,
      mid: null,
      spread: null,
      market_status: 'INDEXED',
      source_time: new Date(rows[0].updated_at).toISOString(),
      latency_ms,
      detail: `Catalog hit ×${rows.length} (${names}) — identity only, no price`,
    };
  } catch (err) {
    const latency_ms = Date.now() - t0;
    const detail = err instanceof Error ? err.message : String(err);
    touchHealth(CATALOG_ID, { status: 'ERROR', ok: false, last_error: detail, latency_ms });
    return {
      sender_id: CATALOG_ID,
      name: 'Capital catalog pulse (DB)',
      kind: 'catalog_pulse',
      epic,
      ok: false,
      bid: null,
      ask: null,
      mid: null,
      spread: null,
      market_status: null,
      source_time: null,
      latency_ms,
      detail,
    };
  }
}

async function readCapitalSender(
  sender: DataSender,
  epic: string
): Promise<SenderRead> {
  const t0 = Date.now();
  const base = {
    sender_id: sender.sender_id,
    name: sender.name,
    kind: 'capital_com' as const,
    epic,
  };
  if (!sender.connection_id) {
    return {
      ...base,
      ok: false,
      bid: null,
      ask: null,
      mid: null,
      spread: null,
      market_status: null,
      source_time: null,
      latency_ms: 0,
      detail: 'Missing connection_id',
    };
  }

  const opened = await getCapitalSession(sender.connection_id);
  if (!opened.ok) {
    const latency_ms = Date.now() - t0;
    touchHealth(sender.sender_id, {
      status: 'ERROR',
      ok: false,
      last_error: opened.detail,
      latency_ms,
    });
    return {
      ...base,
      ok: false,
      bid: null,
      ask: null,
      mid: null,
      spread: null,
      market_status: null,
      source_time: null,
      latency_ms,
      detail: opened.detail,
    };
  }

  try {
    const quote = await fetchCapitalMarketQuote(opened.session, epic);
    const latency_ms = Date.now() - t0;
    if (!quote.raw_ok) {
      touchHealth(sender.sender_id, {
        status: 'ERROR',
        ok: false,
        last_error: quote.detail || 'No bid/offer',
        latency_ms,
      });
      return {
        ...base,
        ok: false,
        bid: quote.bid,
        ask: quote.ask,
        mid: quote.mid,
        spread: quote.spread,
        market_status: quote.market_status,
        source_time: quote.update_time,
        latency_ms,
        detail: quote.detail,
      };
    }

    const now = new Date().toISOString();
    touchHealth(sender.sender_id, {
      status: 'LIVE',
      ok: true,
      last_ok_at: now,
      last_error: null,
      latency_ms,
    });
    return {
      ...base,
      epic: quote.epic || epic,
      ok: true,
      bid: quote.bid,
      ask: quote.ask,
      mid: quote.mid,
      spread: quote.spread,
      market_status: quote.market_status,
      source_time: quote.update_time || now,
      latency_ms,
      detail: quote.detail,
    };
  } catch (err) {
    const latency_ms = Date.now() - t0;
    const detail = err instanceof Error ? err.message : String(err);
    touchHealth(sender.sender_id, { status: 'ERROR', ok: false, last_error: detail, latency_ms });
    return {
      ...base,
      ok: false,
      bid: null,
      ask: null,
      mid: null,
      spread: null,
      market_status: null,
      source_time: null,
      latency_ms,
      detail,
    };
  }
}

function publicReadToSenderRead(r: PublicFeedRead): SenderRead {
  return {
    sender_id: r.sender_id,
    name: r.name,
    kind: r.kind,
    epic: r.epic,
    ok: r.ok,
    bid: r.bid,
    ask: r.ask,
    mid: r.mid,
    spread: r.spread,
    market_status: r.market_status,
    source_time: r.source_time,
    latency_ms: r.latency_ms,
    detail: r.detail,
  };
}

function touchFromPublic(r: PublicFeedRead) {
  touchHealth(r.sender_id, {
    status: r.ok ? 'LIVE' : r.detail?.includes('mapping') || r.detail?.includes('only') ? 'IDLE' : 'ERROR',
    ok: r.ok,
    last_ok_at: r.ok ? new Date().toISOString() : undefined,
    last_error: r.ok ? null : r.detail || 'fail',
    latency_ms: r.latency_ms,
  });
}

function buildConsensus(epics: string[], reads: SenderRead[]) {
  const priceKinds = new Set<SenderKind>([
    'capital_com',
    'yahoo_finance',
    'aurum_metals',
    'fx_live',
    'coinbase',
    'fx_reference',
  ]);
  return epics.map((epic) => {
    const q = epic.toLowerCase();
    const mids = reads
      .filter(
        (r) =>
          r.ok &&
          r.mid != null &&
          priceKinds.has(r.kind) &&
          (r.epic.toLowerCase() === q ||
            r.epic.toLowerCase().includes(q) ||
            q.includes(r.epic.toLowerCase()) ||
            (r.detail || '').toLowerCase().includes(q)),
      )
      .map((r) => r.mid as number);
    const midsFallback =
      mids.length > 0
        ? mids
        : epics.length === 1
          ? reads
              .filter((r) => r.ok && r.mid != null && priceKinds.has(r.kind))
              .map((r) => r.mid as number)
          : [];
    const use = midsFallback;
    if (use.length === 0) {
      return {
        epic,
        contributing: 0,
        mid_avg: null,
        mid_span: null,
        agreement: 'INSUFFICIENT' as const,
      };
    }
    const mixedPublic = reads.some(
      (r) => r.ok && r.mid != null && r.kind !== 'capital_com' && priceKinds.has(r.kind)
    );
    const fused = fusePriceMids(use, { mixedPublic });
    return {
      epic,
      contributing: fused.contributing,
      mid_avg: fused.mid,
      mid_span: fused.span,
      agreement: fused.agreement === 'NONE' ? ('INSUFFICIENT' as const) : fused.agreement,
    };
  });
}

export async function runOrbitScan(epicsInput: string[]): Promise<OrbitScanResult> {
  const epics = [...new Set(epicsInput.map((e) => e.trim()).filter(Boolean))].slice(0, 6);
  const senders = await listDataSenders();
  const capitalSenders = senders.filter(
    (s) => s.kind === 'capital_com' && s.connection_id && s.enabled !== false
  );

  if (epics.length === 0) {
    return {
      scanned_at: new Date().toISOString(),
      epics: [],
      senders,
      reads: [],
      consensus: [],
      note: 'Pick at least one epic/symbol from the Capital catalog.',
    };
  }

  const jobs: Promise<SenderRead>[] = [];
  for (const epic of epics) {
    for (const sender of capitalSenders) {
      jobs.push(readCapitalSender(sender, epic));
    }
    jobs.push(readFxReference(epic));
    jobs.push(readCatalogPulse(epic));
  }

  const publicJobs = epics.map(async (epic) => {
    const rows = await readAllPublicFeeds(epic);
    for (const r of rows) touchFromPublic(r);
    return rows.map(publicReadToSenderRead);
  });

  const [capitalish, publicBatches] = await Promise.all([
    Promise.all(jobs),
    Promise.all(publicJobs),
  ]);
  const reads: SenderRead[] = [...capitalish, ...publicBatches.flat()];
  const refreshed = await listDataSenders();
  const publicCount = PUBLIC_SENDERS.length;

  return {
    scanned_at: new Date().toISOString(),
    epics,
    senders: refreshed,
    reads,
    consensus: buildConsensus(epics, reads),
    note: `Scanning ${epics.length} epic(s) across ${capitalSenders.length} Capital + ${publicCount} public internet providers + FX ref + catalog.`,
  };
}

export async function suggestOrbitEpics(limit = 12): Promise<
  Array<{ epic: string; display_name: string; category: string; connection_id: number }>
> {
  const n = Math.min(Math.max(limit, 1), 80);
  const { rows } = await pool.query(
    `SELECT epic, display_name, category, broker_connection_id as connection_id
     FROM (
       SELECT DISTINCT ON (epic)
              epic, display_name, category, broker_connection_id, updated_at
       FROM capital_markets
       ORDER BY epic, updated_at DESC
     ) t
     ORDER BY display_name ASC
     LIMIT $1`,
    [n]
  );
  return rows.map((r) => ({
    epic: r.epic as string,
    display_name: r.display_name as string,
    category: r.category as string,
    connection_id: r.connection_id as number,
  }));
}

export function feedsFromSenders(senders: DataSender[]) {
  return senders.map((s, idx) => {
    const total = s.reads_ok + s.reads_fail;
    const reliability = total === 0 ? 0 : s.reads_ok / total;
    return {
      source_id: idx + 1,
      sender_id: s.sender_id,
      name: s.name,
      kind: s.kind,
      trust: s.trust,
      status: s.status === 'LIVE' ? 'HEALTHY' : s.status === 'ERROR' ? 'UNHEALTHY' : 'IDLE',
      latency_ms: s.latency_ms ?? 0,
      jitter_ms: 0,
      stale_rate: s.status === 'STALE' ? 1 : 0,
      sequence_gaps: 0,
      divergence: 0,
      reliability,
      predictive_score: reliability,
      last_event: s.last_ok_at || new Date(0).toISOString(),
      last_error: s.last_error,
      reads_ok: s.reads_ok,
      reads_fail: s.reads_fail,
    };
  });
}

export type FeedRole = 'LEAD' | 'CONFIRM' | 'EXECUTE' | 'REJECT';

export type MultiFeedLeg = {
  sender_id: string;
  name: string;
  ok: boolean;
  mid: number | null;
  latency_ms: number;
  detail?: string;
  /** Professional multi-feed role */
  role?: FeedRole;
};

export type MultiFeedPrice = {
  epic: string;
  mid: number | null;
  contributing: number;
  sender_count: number;
  agreement: 'STRONG' | 'OK' | 'DIVERGENT' | 'INSUFFICIENT' | 'NONE';
  mids: number[];
  legs: MultiFeedLeg[];
  detail: string;
  /** Capital legs that returned a mid (execution venue). */
  capital_contributing?: number;
  capital_sender_count?: number;
  /** Public legs kept after Capital-anchor filter. */
  public_contributing?: number;
  /** True when OHLC mid is safe to use for Capital trading. */
  anchored_to_capital?: boolean;
  /** Fastest public-near mid (LEAD truth). */
  lead_mid?: number | null;
  lead_label?: string | null;
};

const ANCHOR_MAX_REL = 0.008; // 0.8% — public must be near Capital CFD mid
/** Metals spot vs Capital GOLD CFD often sits a bit wider than FX — still usable. */
const ANCHOR_MAX_REL_METALS = 0.015;

function nearAnchor(mid: number, anchor: number, maxRel = ANCHOR_MAX_REL): boolean {
  if (!Number.isFinite(mid) || !Number.isFinite(anchor) || anchor === 0) return false;
  return Math.abs(mid - anchor) / Math.abs(anchor) <= maxRel;
}

function anchorRelForEpic(epic: string): number {
  const s = String(epic || '').toUpperCase();
  if (/GOLD|XAU|SILVER|XAG|PLAT|XPT|PALL|XPD/.test(s)) return ANCHOR_MAX_REL_METALS;
  return ANCHOR_MAX_REL;
}

/**
 * Read Capital + public providers, but **anchor to Capital trading mid**.
 * Public internet prices that are far from the robot's Capital quote are advisory
 * only — they must not rewrite OHLC or block entries (spot/futures ≠ CFD scale).
 */
export async function readMultiFeedPrice(
  epicInput: string,
  opts?: { anchorMid?: number | null }
): Promise<MultiFeedPrice> {
  const epic = String(epicInput || '').trim();
  const anchor = opts?.anchorMid != null && Number.isFinite(opts.anchorMid) ? opts.anchorMid : null;
  if (!epic) {
    return {
      epic: '',
      mid: null,
      contributing: 0,
      sender_count: 0,
      agreement: 'NONE',
      mids: [],
      legs: [],
      detail: 'epic required',
      capital_contributing: 0,
      capital_sender_count: 0,
      public_contributing: 0,
      anchored_to_capital: false,
    };
  }

  const senders = await listDataSenders();
  const capitalSenders = senders.filter(
    (s) => s.kind === 'capital_com' && s.connection_id && s.enabled !== false
  );

  const [capitalReads, publicReads, fxRead] = await Promise.all([
    Promise.all(capitalSenders.map((s) => readCapitalSender(s, epic))),
    readAllPublicFeeds(epic),
    readFxReference(epic),
  ]);

  for (const r of publicReads) touchFromPublic(r);

  const fxApplicable = !(fxRead.detail || '').toLowerCase().includes('only applies');
  const publicConfiguredForEpic = publicReads.filter((r) => {
    const d = (r.detail || '').toLowerCase();
    const na =
      d.includes('no yahoo mapping') ||
      d.includes('only prices') ||
      d.includes('only for major') ||
      d.includes('fx live only') ||
      d.includes('coinbase only');
    return !na;
  }).length;

  const capitalMids = capitalReads
    .filter((r) => r.ok && r.mid != null && Number.isFinite(r.mid))
    .map((r) => r.mid as number);

  // Anchor = robot Capital quote, else Capital consensus, else null
  const effectiveAnchor =
    anchor ??
    (capitalMids.length
      ? fusePriceMids(capitalMids, { mixedPublic: false }).mid
      : null);

  const publicOkReads = [
    ...publicReads.map(publicReadToSenderRead),
    ...(fxApplicable ? [fxRead] : []),
  ].filter((r) => r.ok && r.mid != null && Number.isFinite(r.mid));

  const anchorBand = anchorRelForEpic(epic);
  const publicNear = effectiveAnchor
    ? publicOkReads.filter((r) => nearAnchor(r.mid as number, effectiveAnchor, anchorBand))
    : publicOkReads;

  const publicFar = effectiveAnchor
    ? publicOkReads.filter((r) => !nearAnchor(r.mid as number, effectiveAnchor, anchorBand))
    : [];

  const fuseMids = [
    ...capitalMids,
    ...publicNear.map((r) => r.mid as number),
  ];

  const legs: MultiFeedLeg[] = [
    ...capitalReads.map((r) => ({
      sender_id: r.sender_id,
      name: r.name,
      ok: !!(r.ok && r.mid != null),
      mid: r.mid,
      latency_ms: r.latency_ms,
      detail: r.detail,
      role: 'EXECUTE' as FeedRole,
    })),
    ...publicNear.map((r) => ({
      sender_id: r.sender_id,
      name: r.name,
      ok: true,
      mid: r.mid,
      latency_ms: r.latency_ms,
      detail: `${r.detail || ''} · LEAD/CONFIRM near Capital`.trim(),
      role: (r.latency_ms > 0 && r.latency_ms < 800 ? 'LEAD' : 'CONFIRM') as FeedRole,
    })),
    ...publicFar.map((r) => ({
      sender_id: r.sender_id,
      name: r.name,
      ok: false,
      mid: r.mid,
      latency_ms: r.latency_ms,
      detail: `${r.detail || ''} · REJECT FAR from Capital (${effectiveAnchor?.toFixed(2)})`.trim(),
      role: 'REJECT' as FeedRole,
    })),
  ];

  const leadCandidates = publicNear
    .filter((r) => r.mid != null && Number.isFinite(r.mid))
    .slice()
    .sort((a, b) => a.latency_ms - b.latency_ms);
  const lead = leadCandidates[0];
  const lead_mid = lead?.mid ?? null;
  const lead_label = lead ? `${lead.name} (LEAD)` : null;

  const sender_count =
    capitalSenders.length + publicConfiguredForEpic + (fxApplicable ? 1 : 0);

  if (fuseMids.length === 0) {
    // Fall back to anchor alone so robot can still trade on Capital quote
    if (effectiveAnchor != null) {
      return {
        epic,
        mid: effectiveAnchor,
        contributing: 1,
        sender_count,
        agreement: 'INSUFFICIENT',
        mids: [effectiveAnchor],
        legs,
        detail: `Capital-anchored LOCAL mid=${effectiveAnchor.toFixed(5)} · public far/unavailable`,
        capital_contributing: capitalMids.length,
        capital_sender_count: capitalSenders.length,
        public_contributing: 0,
        anchored_to_capital: true,
        lead_mid,
        lead_label,
      };
    }
    return {
      epic,
      mid: null,
      contributing: 0,
      sender_count,
      agreement: sender_count === 0 ? 'NONE' : 'INSUFFICIENT',
      mids: [],
      legs,
      detail: `0/${sender_count} providers near Capital`,
      capital_contributing: 0,
      capital_sender_count: capitalSenders.length,
      public_contributing: 0,
      anchored_to_capital: false,
      lead_mid,
      lead_label,
    };
  }

  const mixedPublic = publicNear.length > 0;
  const fused = fusePriceMids(fuseMids.length ? fuseMids : effectiveAnchor != null ? [effectiveAnchor] : [], {
    mixedPublic,
  });

  // Execution venue wins: robot Capital quote (anchor) / Capital peers — never pure public mid.
  let mid: number | null = null;
  let anchored = false;
  if (capitalMids.length >= 1) {
    mid = fusePriceMids(capitalMids, { mixedPublic: false }).mid;
    anchored = true;
  } else if (effectiveAnchor != null) {
    mid = effectiveAnchor;
    anchored = true;
  } else {
    mid = fused.mid;
  }

  return {
    epic,
    mid,
    contributing: Math.max(fused.contributing, capitalMids.length || (effectiveAnchor != null ? 1 : 0)),
    sender_count,
    agreement: fused.agreement === 'NONE' && mid != null ? 'INSUFFICIENT' : fused.agreement,
    mids: fused.inliers.length ? fused.inliers : mid != null ? [mid] : [],
    legs,
    detail: `${fused.contributing}/${sender_count} near-anchor · ${fused.agreement} · mid=${
      mid != null ? mid.toFixed(5) : '—'
    } · capital=${capitalMids.length} publicNear=${publicNear.length} publicFar=${publicFar.length} · lead=${
      lead_label || '—'
    }`,
    capital_contributing: capitalMids.length,
    capital_sender_count: capitalSenders.length,
    public_contributing: publicNear.length,
    anchored_to_capital: anchored,
    lead_mid,
    lead_label,
  };
}

/**
 * Prefer MULTI only when it stays near the robot's Capital mid.
 * Never let Yahoo/Aurum spot rewrite CFD OHLC when scales differ.
 */
export function pickOhlcMid(
  localMid: number | null | undefined,
  multi: Pick<
    MultiFeedPrice,
    'mid' | 'contributing' | 'agreement' | 'anchored_to_capital'
  > | null | undefined
): { mid: number | null; source: 'MULTI' | 'LOCAL' | 'NONE' } {
  const localOk = localMid != null && Number.isFinite(localMid);
  const multiOk =
    multi &&
    multi.mid != null &&
    Number.isFinite(multi.mid) &&
    multi.contributing >= 2 &&
    (multi.agreement === 'STRONG' || multi.agreement === 'OK');

  if (multiOk && localOk) {
    if (nearAnchor(multi.mid as number, localMid as number, ANCHOR_MAX_REL)) {
      // Blend slightly toward Capital for execution safety
      const blended = (multi.mid as number) * 0.35 + (localMid as number) * 0.65;
      return { mid: blended, source: 'MULTI' };
    }
    return { mid: localMid as number, source: 'LOCAL' };
  }
  if (localOk) return { mid: localMid as number, source: 'LOCAL' };
  if (multi?.mid != null && Number.isFinite(multi.mid)) {
    return { mid: multi.mid, source: 'MULTI' };
  }
  return { mid: null, source: 'NONE' };
}

/** True when ≥2 near-anchor providers agree AND result is Capital-safe. */
export function multiFeedOwnsOhlc(
  multi:
    | Pick<MultiFeedPrice, 'contributing' | 'agreement' | 'anchored_to_capital' | 'capital_contributing'>
    | null
    | undefined
): boolean {
  if (!multi) return false;
  // Only let multi own OHLC when Capital is in the cluster (or anchored)
  if ((multi.capital_contributing ?? 0) < 1 && !multi.anchored_to_capital) return false;
  return (
    multi.contributing >= 2 &&
    (multi.agreement === 'STRONG' || multi.agreement === 'OK')
  );
}

/**
 * Professional feed gate:
 * - Capital EXECUTE always required path (caller has quote)
 * - If LEAD public exists and is DIVERGENT vs Capital cluster → hard block
 * - Multiple Capital peers DIVERGENT → hard block
 */
export function allowEntryFromFeeds(
  multi: Pick<
    MultiFeedPrice,
    | 'contributing'
    | 'sender_count'
    | 'agreement'
    | 'capital_contributing'
    | 'capital_sender_count'
    | 'public_contributing'
    | 'lead_mid'
    | 'mid'
  > | null | undefined
): { ok: boolean; reason: string } {
  if (!multi) {
    return { ok: true, reason: 'multi snapshot missing — Capital local OK' };
  }

  const capitalLive = multi.capital_contributing ?? 0;
  const capitalConfigured = multi.capital_sender_count ?? 0;
  const publicLive = multi.public_contributing ?? 0;

  if (capitalLive >= 2 && multi.agreement === 'DIVERGENT') {
    return {
      ok: false,
      reason: `FEED BLOCK · Capital peers DIVERGENT (${capitalLive}/${capitalConfigured})`,
    };
  }

  if (
    publicLive >= 1 &&
    multi.lead_mid != null &&
    multi.mid != null &&
    Number.isFinite(multi.lead_mid) &&
    Number.isFinite(multi.mid)
  ) {
    const rel = Math.abs(multi.lead_mid - multi.mid) / Math.max(Math.abs(multi.mid), 1e-9);
    if (rel >= 0.0025 && multi.agreement === 'DIVERGENT') {
      return {
        ok: false,
        reason: `FEED BLOCK · LEAD vs EXECUTE diverge ${(rel * 100).toFixed(2)}%`,
      };
    }
  }

  return {
    ok: true,
    reason: `FEED OK · Capital ${capitalLive}/${capitalConfigured} · LEAD public ${publicLive} · ${multi.agreement}`,
  };
}
