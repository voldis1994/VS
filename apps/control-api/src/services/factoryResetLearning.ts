/**
 * Factory learn-from-scratch reset.
 * KEEP: clients, Capital credentials, broker accounts, capital_markets, lot settings.
 * WIPE: genome → DEFAULT, experience, learners, auto-cal, desk Soft/Peak/Target,
 *       optional trade/position/audit history. Robots stop (open deals stay MANAGE-only).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  defaultBrainGenome,
  genomePath,
  setBrainGenome,
  reloadBrainGenome,
} from '../brainSelfImprove/brainGenome.js';
import { experiencePath, saveExperience } from '../brainSelfImprove/experience.js';
import type { BrainExperience } from '../brainSelfImprove/experience.js';
import { resetClientToOpenTradeAll } from './autoCalibrate.js';
import {
  defaultDeskCalibration,
  setDeskCalibration,
  _resetDeskCalibrationCacheForTests,
} from './deskCalibration.js';
import { _resetLearnerForTests } from './deskLearner.js';
import { _resetEntryLearnerForTests } from './entryLearner.js';
import {
  clearRunningRobotsSnapshot,
  listRobotSessions,
  runningRobotsSnapshotPath,
  stopRobotSession,
} from './robotDesk.js';

const { Client } = pg;

function dbConfig() {
  return {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'market_reader',
    user: process.env.DB_USER || 'market_reader',
    password: process.env.DB_PASSWORD || 'CHANGE_ME',
    connectionTimeoutMillis: 3_000,
    query_timeout: 8_000,
  };
}

function log(msg: string): void {
  console.log(`[factory-reset] ${msg}`);
}

export const FACTORY_RESET_CONFIRM = 'LEARN_FROM_SCRATCH';

export type FactoryResetLearningOpts = {
  /** Must equal LEARN_FROM_SCRATCH */
  confirm: string;
  /** Wipe Postgres trades/positions/executions/audit (default true) */
  wipe_db_history?: boolean;
  /** Allow reset while a robot has an open deal (default false) */
  force_open_trades?: boolean;
  /** Delete brain snapshots/versions/candidates (default true) */
  wipe_brain_history?: boolean;
};

export type FactoryResetLearningResult = {
  ok: true;
  at: string;
  kept: string[];
  wiped: string[];
  clients_reset: number[];
  robots_stopped: string[];
  robots_manage_only: string[];
  genome_path: string;
  db_history_wiped: boolean;
};

function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../../');
}

function brainDir(): string {
  return path.join(repoRoot(), 'data', 'brain-self-improve');
}

function dataDir(): string {
  return path.join(process.cwd(), 'data');
}

function rmQuiet(p: string): boolean {
  try {
    if (!fs.existsSync(p)) return false;
    const st = fs.statSync(p);
    if (st.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
    else fs.unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

function listClientIdsFromDisk(): number[] {
  const ids = new Set<number>([0]);
  const roots = [
    path.join(dataDir(), 'desk-calibration'),
    path.join(dataDir(), 'auto-calibrate'),
    path.join(dataDir(), 'desk-learner'),
    path.join(dataDir(), 'desk-entry-learner'),
    path.join(repoRoot(), 'data', 'desk-calibration'),
  ];
  for (const dir of roots) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        const m = /^client-(\d+)\.json$/i.exec(name);
        if (m) ids.add(Number(m[1]));
      }
    } catch {
      /* ignore */
    }
  }
  return [...ids].sort((a, b) => a - b);
}

/** One short-lived Client — never hang the shared pool when Postgres is down. */
async function withDbClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T | null> {
  const c = new Client(dbConfig());
  try {
    await c.connect();
    return await fn(c);
  } catch (e) {
    log(`DB skip: ${e instanceof Error ? e.message : e}`);
    return null;
  } finally {
    try {
      await c.end();
    } catch {
      /* ignore */
    }
  }
}

async function listClientIdsFromDb(): Promise<number[]> {
  const rows = await withDbClient(async (c) => {
    const r = await c.query<{ id: number }>(`SELECT id FROM clients ORDER BY id`);
    return r.rows.map((x) => Number(x.id)).filter((n) => Number.isFinite(n) && n > 0);
  });
  return rows || [];
}

async function wipeDbHistory(): Promise<string[]> {
  const wiped: string[] = [];
  const tables = [
    'trades',
    'positions',
    'executions',
    'trade_intents',
    'evidence_reports',
    'market_state_snapshots',
    'pipeline_intent_dedupe',
    'pipeline_execution_claims',
    'audit_logs',
    'system_events',
  ];
  const ok = await withDbClient(async (c) => {
    await c.query('SELECT 1');
    for (const t of tables) {
      try {
        await c.query(`TRUNCATE TABLE ${t} RESTART IDENTITY CASCADE`);
        wiped.push(`db:${t}`);
      } catch {
        try {
          await c.query(`DELETE FROM ${t}`);
          wiped.push(`db:${t}`);
        } catch {
          log(`DB table skip: ${t}`);
        }
      }
    }
    return true;
  });
  if (!ok) log('DB unreachable — history wipe skipped (genome/learners still reset)');
  return wiped;
}

/** Rename heavy brain dirs (instant) instead of recursive delete of thousands of files. */
function retireDir(dir: string): boolean {
  try {
    if (!fs.existsSync(dir)) return false;
    const dest = `${dir}.trash-${Date.now()}`;
    fs.renameSync(dir, dest);
    // Best-effort async cleanup — do not block reset
    setTimeout(() => {
      try {
        fs.rmSync(dest, { recursive: true, force: true });
      } catch {
        /* leave .trash-* for operator */
      }
    }, 0);
    return true;
  } catch {
    return rmQuiet(dir);
  }
}

function wipeJsonTrees(wipeBrainHistory: boolean): string[] {
  const wiped: string[] = [];
  const files = [
    path.join(dataDir(), 'desk-calibration.json'),
    path.join(dataDir(), 'auto-calibrate-session.json'),
    path.join(dataDir(), 'desk-learner-session.json'),
    path.join(repoRoot(), 'data', 'desk-calibration.json'),
    experiencePath(),
    runningRobotsSnapshotPath(),
    path.join(brainDir(), 'reload-needed.json'),
  ];
  for (const f of files) {
    if (rmQuiet(f)) wiped.push(f);
  }
  const dirs = [
    path.join(dataDir(), 'desk-calibration'),
    path.join(dataDir(), 'auto-calibrate'),
    path.join(dataDir(), 'desk-learner'),
    path.join(dataDir(), 'desk-entry-learner'),
    path.join(repoRoot(), 'data', 'desk-calibration'),
  ];
  for (const d of dirs) {
    if (rmQuiet(d)) wiped.push(d);
  }
  if (wipeBrainHistory) {
    for (const d of [
      path.join(brainDir(), 'snapshots'),
      path.join(brainDir(), 'versions'),
      path.join(brainDir(), 'candidates'),
    ]) {
      if (retireDir(d)) wiped.push(`${d}→trash`);
    }
  }
  return wiped;
}

function writeFactoryGenome(): string {
  const g = defaultBrainGenome();
  g.updated_at = new Date().toISOString();
  g.last_lesson = 'FACTORY LEARN_FROM_SCRATCH';
  setBrainGenome(g);
  reloadBrainGenome();
  return genomePath();
}

function emptyExperienceFile(): void {
  const empty: BrainExperience = {
    version: 1,
    updated_at: new Date().toISOString(),
    cycles: [],
    patterns: [],
    rejected_signatures: [],
    accepted_signatures: [],
    soft_pause_side: null,
    soft_pause_left: 0,
    soft_sell_streak: 0,
    soft_buy_streak: 0,
    last_lesson: 'FACTORY LEARN_FROM_SCRATCH',
  };
  saveExperience(empty);
}

/**
 * Full learn-from-scratch reset. Capital API + clients untouched.
 */
export async function factoryResetLearning(
  opts: FactoryResetLearningOpts
): Promise<FactoryResetLearningResult> {
  if (String(opts.confirm || '').trim() !== FACTORY_RESET_CONFIRM) {
    throw Object.assign(
      new Error(`confirm must be exactly "${FACTORY_RESET_CONFIRM}"`),
      { statusCode: 400 }
    );
  }

  const open = listRobotSessions().some((s) => s.running && (s.open_side || s.deal_id));
  if (open && !opts.force_open_trades) {
    throw Object.assign(
      new Error(
        'Open robot trade(s) — close/FLAT first, or pass force_open_trades:true (MANAGE keeps deal)'
      ),
      { statusCode: 409 }
    );
  }

  const wiped: string[] = [];
  const robots_stopped: string[] = [];
  const robots_manage_only: string[] = [];

  log('stop robots…');
  for (const s of listRobotSessions()) {
    if (!s.running) continue;
    const beforeOpen = Boolean(s.open_side || s.deal_id);
    await stopRobotSession(s.id);
    if (beforeOpen) robots_manage_only.push(s.id);
    else robots_stopped.push(s.id);
  }
  try {
    clearRunningRobotsSnapshot();
    wiped.push(runningRobotsSnapshotPath());
  } catch {
    /* optional */
  }

  log('wipe desk/learner JSON…');
  wiped.push(...wipeJsonTrees(opts.wipe_brain_history !== false));

  log('write factory genome…');
  const gPath = writeFactoryGenome();
  wiped.push(`${gPath}→DEFAULT`);
  emptyExperienceFile();
  wiped.push(`${experiencePath()}→empty`);

  _resetDeskCalibrationCacheForTests();
  log('load client ids (DB 3s max)…');
  const dbIds = await listClientIdsFromDb();
  const diskIds = listClientIdsFromDisk();
  const clientIds = [...new Set([0, ...dbIds, ...diskIds])].sort((a, b) => a - b);

  log(`reset ${clientIds.length} client desk/learner…`);
  for (const id of clientIds) {
    try {
      _resetLearnerForTests(id);
      _resetEntryLearnerForTests(id);
      setDeskCalibration({ ...defaultDeskCalibration() }, id);
      resetClientToOpenTradeAll(id, 'factory_learn_from_scratch');
    } catch {
      /* best-effort per client */
    }
  }

  let db_history_wiped = false;
  if (opts.wipe_db_history !== false) {
    log('wipe DB trade/audit history…');
    const dbWiped = await wipeDbHistory();
    wiped.push(...dbWiped);
    db_history_wiped = dbWiped.some((x) => x.startsWith('db:'));
  }
  log('done.');

  return {
    ok: true,
    at: new Date().toISOString(),
    kept: [
      'clients',
      'broker_connections',
      'api_credential_metadata',
      'broker_accounts',
      'account_instrument_settings',
      'capital_markets',
      'users',
      'MASTER_ENCRYPTION_KEY / .env',
    ],
    wiped,
    clients_reset: clientIds,
    robots_stopped,
    robots_manage_only,
    genome_path: gPath,
    db_history_wiped,
  };
}
