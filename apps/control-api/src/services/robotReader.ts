import { pool } from '../db/pool.js';
import { decrypt } from '../security/encryption.js';
import {
  CapitalSession,
  acquireCapitalSession,
  fetchCapitalMarketQuote,
} from './capitalCom.js';

export type SenderKind = 'capital_com' | 'fx_reference' | 'catalog_pulse';

export interface DataSender {
  sender_id: string;
  name: string;
  kind: SenderKind;
  trust: 'broker_live' | 'broker_demo' | 'public_ref' | 'catalog';
  environment?: string;
  connection_id?: number;
  client_name?: string;
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

type SessionCache = {
  session: CapitalSession;
  expiresAt: number;
};

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

  // Shared pool with Robot Desk — one login per Capital identity
  const opened = await acquireCapitalSession({
    environment: conn.environment,
    apiKey,
    identifier,
    password,
  });
  if (!opened.ok) return { ok: false, detail: opened.result.detail };
  return { ok: true, session: opened.session };
}

export async function listDataSenders(): Promise<DataSender[]> {
  const { rows } = await pool.query(
    `SELECT bc.id, bc.broker_name, bc.environment, bc.enabled, bc.identifier,
            c.name as client_name,
            (SELECT COUNT(*)::int FROM capital_markets cm WHERE cm.broker_connection_id = bc.id) as markets
     FROM broker_connections bc
     JOIN clients c ON c.id = bc.client_id
     WHERE bc.broker_name = 'capital_com'
     ORDER BY bc.id ASC`
  );

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

  return senders;
}

/** Map Capital epic / symbol heuristics to ISO FX pair for Frankfurter. */
export function epicToFxPair(epic: string): { from: string; to: string } | null {
  const s = epic.toUpperCase().replace(/[^A-Z]/g, '');
  const majors = ['EUR', 'USD', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD'];
  for (const a of majors) {
    for (const b of majors) {
      if (a === b) continue;
      if (s.includes(a + b)) return { from: a, to: b };
    }
  }
  return null;
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

function buildConsensus(epics: string[], reads: SenderRead[]) {
  return epics.map((epic) => {
    const q = epic.toLowerCase();
    const mids = reads
      .filter(
        (r) =>
          r.ok &&
          r.mid != null &&
          r.kind === 'capital_com' &&
          (r.epic.toLowerCase() === q ||
            r.epic.toLowerCase().includes(q) ||
            q.includes(r.epic.toLowerCase()) ||
            (r.detail || '').toLowerCase().includes(q)),
      )
      .map((r) => r.mid as number);
    // Fallback: any successful capital mid from this scan if only one epic requested
    const midsFallback =
      mids.length > 0
        ? mids
        : epics.length === 1
          ? reads
              .filter((r) => r.ok && r.mid != null && r.kind === 'capital_com')
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
    const avg = use.reduce((a, b) => a + b, 0) / use.length;
    const span = Math.max(...use) - Math.min(...use);
    const rel = avg !== 0 ? span / Math.abs(avg) : span;
    let agreement: 'STRONG' | 'OK' | 'DIVERGENT' | 'INSUFFICIENT' = 'OK';
    if (use.length >= 2 && rel < 0.0005) agreement = 'STRONG';
    else if (use.length >= 2 && rel > 0.005) agreement = 'DIVERGENT';
    return {
      epic,
      contributing: use.length,
      mid_avg: avg,
      mid_span: span,
      agreement,
    };
  });
}

export async function runOrbitScan(epicsInput: string[]): Promise<OrbitScanResult> {
  const epics = [...new Set(epicsInput.map((e) => e.trim()).filter(Boolean))].slice(0, 6);
  const senders = await listDataSenders();
  const capitalSenders = senders.filter((s) => s.kind === 'capital_com' && s.connection_id);

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

  const reads = await Promise.all(jobs);
  const refreshed = await listDataSenders();

  return {
    scanned_at: new Date().toISOString(),
    epics,
    senders: refreshed,
    reads,
    consensus: buildConsensus(epics, reads),
    note:
      capitalSenders.length === 0
        ? 'No Capital.com broker connections — add Brokers (can add several Live/Demo rows). Orbit still runs catalog + FX reference.'
        : `Scanning ${epics.length} epic(s) across ${capitalSenders.length} Capital sender(s) + FX ref + catalog pulse.`,
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
