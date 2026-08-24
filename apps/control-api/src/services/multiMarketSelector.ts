/**
 * Multi-market selector — one brain, many markets.
 * Scans a popular universe on one Capital connection, scores setups,
 * fires a single EntryReady for the best epic (clients execute via fanout).
 */
import { pool } from '../db/pool.js';
import { decrypt } from '../security/encryption.js';
import {
  fetchCapitalMinutePrices,
  fetchCapitalPrices,
  isLateMoveOnOneMinute,
  leaseCapitalSession,
} from './capitalCom.js';
import { decideEntryFrom10sRegime, type RegimeEntry } from './entryFromRegime.js';
import { fanoutEntryIntent, type FanoutResult } from './intentFanout.js';
import { observeClosedBars, type RegimeName } from './regimes.js';
import { aggregateSecondsToTen, bodyPct, type TenSecBar } from './tenSecondOhlc.js';

/** Popular universe needles — resolved against this connection's capital_markets. */
export const DEFAULT_UNIVERSE_NEEDLES = [
  'GOLD',
  'SILVER',
  'XAU',
  'XAG',
  'OIL',
  'BRENT',
  'WTI',
  'USOIL',
  'UKOIL',
  'US100',
  'NAS100',
  'US500',
  'DE40',
  'BTC',
  'ETH',
  'EURUSD',
  'GBPUSD',
] as const;

const SCAN_CADENCE_MS = 8_000;
const FIRE_COOLDOWN_MS = 30_000;
const MIN_FIRE_SCORE = 78;
const MAX_UNIVERSE = 12;

export type MarketCandidate = {
  epic: string;
  display_name: string;
  category: string;
  regime: RegimeName | string;
  direction: 'BUY' | 'SELL' | null;
  setup: string | null;
  score: number;
  reason: string;
  mid: number | null;
  skipped?: string | null;
};

export type MultiMarketStatus = {
  running: boolean;
  account_id: number | null;
  connection_id: number | null;
  client_name: string | null;
  universe: Array<{ epic: string; display_name: string; category: string }>;
  candidates: MarketCandidate[];
  pick: MarketCandidate | null;
  last_scan_at: string | null;
  last_fire_at: string | null;
  last_fire_detail: string | null;
  last_error: string | null;
  fire_cooldown_ms: number;
  min_score: number;
};

type Internal = {
  running: boolean;
  account_id: number;
  connection_id: number;
  client_name: string;
  capital_account_id: string | null;
  environment: string;
  universe: Array<{ epic: string; display_name: string; category: string }>;
  candidates: MarketCandidate[];
  pick: MarketCandidate | null;
  last_scan_at: string | null;
  last_fire_at: number;
  last_fire_detail: string | null;
  last_error: string | null;
  timer: ReturnType<typeof setInterval> | null;
  cycle_busy: boolean;
};

let state: Internal | null = null;

async function loadCreds(connectionId: number): Promise<Record<string, string>> {
  const { rows } = await pool.query(
    `SELECT credential_type, ciphertext, iv, tag
     FROM api_credential_metadata WHERE broker_connection_id = $1`,
    [connectionId]
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

function needleRank(epic: string, display: string, needle: string): number {
  const e = epic.toUpperCase();
  const d = display.toUpperCase();
  const n = needle.toUpperCase();
  if (e === n) return 100;
  if (e.startsWith(n) && e.length <= n.length + 4) return 90;
  if (d === n || d.startsWith(n + ' ')) return 85;
  if (e.includes(n)) return 70;
  if (d.includes(n)) return 60;
  return 0;
}

/** Resolve popular needles → concrete Capital epics on this connection. */
export async function resolveUniverseForConnection(
  connectionId: number,
  needles: readonly string[] = DEFAULT_UNIVERSE_NEEDLES
): Promise<Array<{ epic: string; display_name: string; category: string }>> {
  const { rows } = await pool.query(
    `SELECT epic, display_name, category
     FROM capital_markets
     WHERE broker_connection_id = $1
     ORDER BY updated_at DESC NULLS LAST`,
    [connectionId]
  );

  const picked = new Map<string, { epic: string; display_name: string; category: string; rank: number }>();
  for (const needle of needles) {
    let best: { epic: string; display_name: string; category: string; rank: number } | null = null;
    for (const r of rows) {
      const epic = String(r.epic || '');
      const display_name = String(r.display_name || epic);
      const category = String(r.category || 'other');
      const rank = needleRank(epic, display_name, needle);
      if (rank < 60) continue;
      if (!best || rank > best.rank) {
        best = { epic, display_name, category, rank };
      }
    }
    if (best && !picked.has(best.epic)) {
      picked.set(best.epic, best);
    }
  }

  return [...picked.values()]
    .sort((a, b) => b.rank - a.rank)
    .slice(0, MAX_UNIVERSE)
    .map(({ epic, display_name, category }) => ({ epic, display_name, category }));
}

/**
 * Score a live setup. Higher = better to fire.
 * Prefers fresh BREAKOUT over mid-move chase; rejects empty/null.
 */
export function scoreMarketSetup(input: {
  entry: RegimeEntry | null;
  regime: string;
  bar: TenSecBar | null;
}): { score: number; reason: string } {
  const { entry, regime, bar } = input;
  if (!entry || !bar) return { score: 0, reason: 'no setup' };

  let score = 0;
  const setup = String(entry.setup || '').toUpperCase();
  const r = String(regime || '').toUpperCase();
  const bp = Math.abs(bodyPct(bar));

  if (setup === 'BREAKOUT') score += 55;
  else if (setup === 'PULLBACK') score += 40;
  else score += 30;

  if (r === 'BREAKOUT_UP' || r === 'BREAKOUT_DOWN') score += 20;
  else if (r === 'TREND_UP' || r === 'TREND_DOWN') score += 12;
  else if (r === 'COMPRESSION') score += 4;

  // Sweet spot body — enough to be real, not already spent (~0.015%–0.065%)
  if (bp >= 0.00015 && bp <= 0.00065) score += 18;
  else if (bp > 0.00065 && bp < 0.00075) score += 8;
  else if (bp < 0.00015) score += 2;
  else score -= 25; // spent bar

  if (String(entry.reason || '').includes('STRUCT BO')) score += 6;

  return {
    score: Math.max(0, Math.min(100, score)),
    reason: `${entry.reason} · score ${score}`,
  };
}

export function getMultiMarketStatus(): MultiMarketStatus {
  if (!state) {
    return {
      running: false,
      account_id: null,
      connection_id: null,
      client_name: null,
      universe: [],
      candidates: [],
      pick: null,
      last_scan_at: null,
      last_fire_at: null,
      last_fire_detail: null,
      last_error: null,
      fire_cooldown_ms: FIRE_COOLDOWN_MS,
      min_score: MIN_FIRE_SCORE,
    };
  }
  return {
    running: state.running,
    account_id: state.account_id,
    connection_id: state.connection_id,
    client_name: state.client_name,
    universe: state.universe,
    candidates: state.candidates,
    pick: state.pick,
    last_scan_at: state.last_scan_at,
    last_fire_at: state.last_fire_at ? new Date(state.last_fire_at).toISOString() : null,
    last_fire_detail: state.last_fire_detail,
    last_error: state.last_error,
    fire_cooldown_ms: FIRE_COOLDOWN_MS,
    min_score: MIN_FIRE_SCORE,
  };
}

export async function startMultiMarketSelector(input: {
  account_id: number;
  needles?: string[];
}): Promise<MultiMarketStatus> {
  const accountId = Number(input.account_id);
  if (!Number.isFinite(accountId) || accountId <= 0) {
    throw new Error('account_id required');
  }

  const { rows } = await pool.query(
    `SELECT ba.id as account_id, ba.external_account_id,
            bc.id as connection_id, bc.environment, bc.broker_name, bc.identifier,
            c.name as client_name
     FROM broker_accounts ba
     JOIN broker_connections bc ON bc.id = ba.broker_connection_id
     JOIN clients c ON c.id = bc.client_id
     WHERE ba.id = $1`,
    [accountId]
  );
  if (!rows.length) throw new Error('Trading account not found');
  const row = rows[0] as {
    account_id: number;
    external_account_id: string | null;
    connection_id: number;
    environment: string;
    broker_name: string;
    identifier: string | null;
    client_name: string;
  };
  if (row.broker_name !== 'capital_com') throw new Error('Multi-market requires Capital.com account');

  const universe = await resolveUniverseForConnection(
    row.connection_id,
    input.needles?.length ? input.needles : DEFAULT_UNIVERSE_NEEDLES
  );
  if (!universe.length) {
    throw new Error('No popular markets found on this Capital catalog — run Trading Pull ALL first');
  }

  stopMultiMarketSelector();

  state = {
    running: true,
    account_id: row.account_id,
    connection_id: row.connection_id,
    client_name: row.client_name,
    capital_account_id: row.external_account_id,
    environment: row.environment,
    universe,
    candidates: [],
    pick: null,
    last_scan_at: null,
    last_fire_at: 0,
    last_fire_detail: null,
    last_error: null,
    timer: null,
    cycle_busy: false,
  };

  void scanCycle();
  state.timer = setInterval(() => {
    void scanCycle();
  }, SCAN_CADENCE_MS);

  return getMultiMarketStatus();
}

export function stopMultiMarketSelector(): MultiMarketStatus {
  if (state?.timer) clearInterval(state.timer);
  if (state) {
    state.running = false;
    state.timer = null;
    state.cycle_busy = false;
  }
  state = null;
  return getMultiMarketStatus();
}

async function scanCycle(): Promise<void> {
  if (!state || !state.running || state.cycle_busy) return;
  state.cycle_busy = true;
  try {
    const creds = await loadCreds(state.connection_id);
    const { rows } = await pool.query(
      `SELECT identifier FROM broker_connections WHERE id = $1`,
      [state.connection_id]
    );
    const identifier = String(rows[0]?.identifier || '').trim();
    const leased = await leaseCapitalSession({
      environment: state.environment,
      apiKey: creds.api_key || '',
      identifier,
      password: creds.password || '',
      connectionId: state.connection_id,
      capitalAccountId: state.capital_account_id,
    });
    if (!leased.ok) {
      state.last_error = leased.result.detail;
      return;
    }

    try {
      const session = leased.session;
      const candidates: MarketCandidate[] = [];

      // Sequential per epic under one lease — avoids Capital session races
      for (const m of state.universe) {
        const cand = await scanOneEpic(session, m);
        candidates.push(cand);
      }

      candidates.sort((a, b) => b.score - a.score);
      state.candidates = candidates;
      state.pick = candidates.find((c) => c.direction && c.score >= MIN_FIRE_SCORE) || null;
      state.last_scan_at = new Date().toISOString();
      state.last_error = null;

      if (state.pick && state.pick.direction) {
        await maybeFire(state.pick);
      }
    } finally {
      leased.release();
    }
  } catch (err) {
    if (state) {
      state.last_error = err instanceof Error ? err.message : String(err);
    }
  } finally {
    if (state) state.cycle_busy = false;
  }
}

async function scanOneEpic(
  session: Parameters<typeof fetchCapitalPrices>[0],
  m: { epic: string; display_name: string; category: string }
): Promise<MarketCandidate> {
  const scope = `multi:${m.epic}`;
  const sec = await fetchCapitalPrices(session, m.epic, 'SECOND', 40);
  if (!sec.ok || sec.candles.length < 10) {
    return {
      epic: m.epic,
      display_name: m.display_name,
      category: m.category,
      regime: 'COMPRESSION',
      direction: null,
      setup: null,
      score: 0,
      reason: 'OHLC seed fail',
      mid: null,
      skipped: sec.detail || 'no seconds',
    };
  }

  const bars = aggregateSecondsToTen(sec.candles);
  if (bars.length < 4) {
    return {
      epic: m.epic,
      display_name: m.display_name,
      category: m.category,
      regime: 'COMPRESSION',
      direction: null,
      setup: null,
      score: 0,
      reason: 'need ≥4×10s bars',
      mid: bars[bars.length - 1]?.close ?? null,
      skipped: 'thin history',
    };
  }

  const snap = observeClosedBars(m.epic, bars.slice(-12), m.display_name, scope);
  const last = bars[bars.length - 1]!;
  const entry = decideEntryFrom10sRegime(last, snap.current);
  const scored = scoreMarketSetup({ entry, regime: snap.current, bar: last });

  if (!entry) {
    return {
      epic: m.epic,
      display_name: m.display_name,
      category: m.category,
      regime: snap.current,
      direction: null,
      setup: null,
      score: scored.score,
      reason: `${snap.current} · no entry`,
      mid: last.close,
      skipped: 'no #136 regime setup',
    };
  }

  const hist = await fetchCapitalMinutePrices(session, m.epic, 3);
  if (hist.ok && isLateMoveOnOneMinute(entry.direction, hist.candles)) {
    return {
      epic: m.epic,
      display_name: m.display_name,
      category: m.category,
      regime: snap.current,
      direction: null,
      setup: entry.setup,
      score: 0,
      reason: `SKIP late 1m · ${entry.reason}`,
      mid: last.close,
      skipped: 'late on 1m',
    };
  }

  return {
    epic: m.epic,
    display_name: m.display_name,
    category: m.category,
    regime: snap.current,
    direction: entry.direction,
    setup: entry.setup,
    score: scored.score,
    reason: scored.reason,
    mid: last.close,
    skipped: null,
  };
}

async function maybeFire(pick: MarketCandidate): Promise<FanoutResult | null> {
  if (!state || !pick.direction) return null;
  if (Date.now() - state.last_fire_at < FIRE_COOLDOWN_MS) return null;
  if (pick.score < MIN_FIRE_SCORE) return null;

  const barKey = `${pick.epic}:${pick.direction}:${pick.regime}:${Math.round(pick.mid || 0)}`;
  const idem = `mm-${barKey}`.slice(0, 180);

  const result = await fanoutEntryIntent({
    epic: pick.epic,
    direction: pick.direction,
    setup_type: pick.setup,
    regime: String(pick.regime),
    reference_price: pick.mid,
    decision: 'ENTRY_READY',
    explanation: `MULTI-MARKET pick · ${pick.reason}`,
    idempotency_key: idem,
  });

  const fanout = result.fanout;
  state.last_fire_at = Date.now();
  state.last_fire_detail = `${pick.direction} ${pick.display_name} (${pick.epic}) score=${pick.score} · subs=${fanout.subscribers} · ok=${
    fanout.executed.filter((e) => e.ok).length
  }${result.deduped ? ' · deduped' : ''}`;
  return fanout;
}
