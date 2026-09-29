/**
 * E2E: running FLAT robot → BRAIN reload persist → API "death" → restore → same robot polling.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BRAIN_RELOAD_EXIT_CODE,
  LIVE_LOOP_ENV,
  clearBrainReloadRequest,
  requestBrainCodeReload,
} from '../brainSelfImprove/brainReload.js';

const poolQuery = vi.fn();
const emitToClient = vi.fn();

vi.mock('../db/pool.js', () => ({
  pool: { query: (...a: unknown[]) => poolQuery(...a) },
}));

vi.mock('../security/encryption.js', () => ({
  decrypt: () => 'secret',
}));

vi.mock('./clientEvents.js', () => ({
  emitToClient: (...a: unknown[]) => emitToClient(...a),
}));

vi.mock('./capitalCom.js', () => ({
  withCapitalAccountSession: vi.fn(async () => ({
    ok: false,
    result: { ok: false, status: 503, detail: 'test-skip' },
  })),
  closeCapitalPosition: vi.fn(),
  confirmCapitalDeal: vi.fn(),
  createCapitalPosition: vi.fn(),
  updateCapitalPosition: vi.fn(),
  fetchCapitalMarketQuote: vi.fn(async () => null),
  fetchCapitalMinutePrices: vi.fn(async () => []),
  fetchCapitalPrices: vi.fn(async () => []),
  fetchCapitalActivity: vi.fn(async () => []),
  listCapitalOpenPositions: vi.fn(async () => []),
  computeSafetyCushionStopLevel: () => 1995,
  isLateMoveOnOneMinute: () => false,
  parseCapitalCreatedAt: () => null,
}));

vi.mock('./autoCalibrate.js', async () => {
  const actual = await vi.importActual<typeof import('./autoCalibrate.js')>(
    './autoCalibrate.js'
  );
  return {
    ...actual,
    ensureAutoCalibrateSession: () => ({
      closes_in_session: 0,
      knobs_now: {
        hardinv_abs: 1,
        peak_mfe_abs: 2,
        target_abs: 3,
        entry_filter_level: 0,
      },
    }),
  };
});

import {
  _patchRobotSessionForTests,
  _resetRobotSessionsForTests,
  _robotHasPollTimerForTests,
  checkBrainCodeReload,
  clearRunningRobotsSnapshot,
  getRobotSession,
  listRobotSessions,
  persistRunningRobotsForReload,
  restoreRunningRobotsAfterReload,
  robotIdFor,
  runningRobotsSnapshotPath,
  startRobotSession,
} from './robotDesk.js';

describe('robotDesk BRAIN reload session restore', () => {
  const prevLoop = process.env[LIVE_LOOP_ENV];
  const prevSnap = process.env.BRAIN_RUNNING_ROBOTS_PATH;
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'robot-reload-'));
    process.env.BRAIN_RUNNING_ROBOTS_PATH = path.join(tmp, 'running-robots.json');
    process.env[LIVE_LOOP_ENV] = '1';
    clearBrainReloadRequest();
    clearRunningRobotsSnapshot();
    _resetRobotSessionsForTests();
    emitToClient.mockClear();
    poolQuery.mockReset();
    poolQuery.mockImplementation(async (sql: string) => {
      const q = String(sql);
      if (q.includes('FROM broker_accounts ba')) {
        return {
          rows: [
            {
              id: 17,
              display_name: 'Gold Demo',
              external_account_id: 'ext-17',
              connection_id: 9,
              environment: 'demo',
              broker_name: 'capital_com',
              client_id: 3,
              client_name: 'Client A',
            },
          ],
        };
      }
      if (q.includes('FROM capital_markets')) {
        return { rows: [{ epic: 'GOLD', display_name: 'Gold' }] };
      }
      if (q.includes('FROM broker_connections')) {
        return {
          rows: [
            {
              id: 9,
              environment: 'demo',
              identifier: 'user',
              broker_name: 'capital_com',
            },
          ],
        };
      }
      if (q.includes('external_account_id')) {
        return { rows: [{ external_account_id: 'ext-17' }] };
      }
      if (q.includes('FROM api_credential_metadata')) {
        return {
          rows: [
            {
              credential_type: 'api_key',
              ciphertext: 'x',
              iv: 'y',
              tag: 'z',
            },
          ],
        };
      }
      return { rows: [] };
    });
  });

  afterEach(async () => {
    _resetRobotSessionsForTests();
    // Drain any in-flight robotCycle from startRobotSession
    await new Promise((r) => setTimeout(r, 50));
    clearBrainReloadRequest();
    clearRunningRobotsSnapshot();
    if (prevLoop === undefined) delete process.env[LIVE_LOOP_ENV];
    else process.env[LIVE_LOOP_ENV] = prevLoop;
    if (prevSnap === undefined) delete process.env.BRAIN_RUNNING_ROBOTS_PATH;
    else process.env.BRAIN_RUNNING_ROBOTS_PATH = prevSnap;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('FLAT robot survives BRAIN reload exit-75 restart (persist → clear → restore → polling)', async () => {
    const started = await startRobotSession({
      account_id: 17,
      epic: 'GOLD',
      lot_size: 0.4,
      trading_enabled: true,
      entry_enabled: true,
    });
    const id = robotIdFor(17, 'GOLD');
    expect(started.id).toBe(id);
    expect(started.running).toBe(true);
    expect(started.mode).toBe('FLAT');
    expect(started.lot_size).toBe(0.4);
    expect(started.entry_enabled).toBe(true);
    expect(_robotHasPollTimerForTests(id)).toBe(true);
    expect(listRobotSessions().some((s) => s.id === id && s.running)).toBe(true);

    // Simulate ACCEPTed .ts + FLAT → checkBrainCodeReload persists then exit 75
    requestBrainCodeReload({
      cycle_id: 'cycle_restore_e2e',
      reason: 'unit',
      files: ['apps/control-api/src/services/traderMind.ts'],
    });
    const exitSpy = stubExit();
    checkBrainCodeReload();
    expect(fs.existsSync(runningRobotsSnapshotPath())).toBe(true);
    const disk = JSON.parse(fs.readFileSync(runningRobotsSnapshotPath(), 'utf8')) as {
      robots: Array<{
        account_id: number;
        epic: string;
        lot_size: number;
        entry_enabled: boolean;
        trading_enabled: boolean;
      }>;
    };
    expect(disk.robots).toEqual([
      expect.objectContaining({
        account_id: 17,
        epic: 'GOLD',
        lot_size: 0.4,
        entry_enabled: true,
        trading_enabled: true,
      }),
    ]);
    await new Promise((r) => setTimeout(r, 200));
    expect(exitSpy.code).toBe(BRAIN_RELOAD_EXIT_CODE);
    exitSpy.restore();

    // Simulate API process death (in-memory Map gone; snapshot on disk remains)
    _resetRobotSessionsForTests();
    expect(getRobotSession(id)).toBeNull();
    expect(listRobotSessions()).toEqual([]);
    expect(_robotHasPollTimerForTests(id)).toBe(false);

    // Boot restore (same as index.ts after clearStaleBrainReloadOnBoot)
    const n = await restoreRunningRobotsAfterReload();
    expect(n).toBe(1);
    expect(fs.existsSync(runningRobotsSnapshotPath())).toBe(false);

    const restored = getRobotSession(id);
    expect(restored).not.toBeNull();
    expect(restored!.running).toBe(true);
    expect(restored!.account_id).toBe(17);
    expect(restored!.epic).toBe('GOLD');
    expect(restored!.lot_size).toBe(0.4);
    expect(restored!.entry_enabled).toBe(true);
    expect(restored!.mode).toBe('FLAT');
    expect(_robotHasPollTimerForTests(id)).toBe(true);
    expect(restored!.ticks.some((t) => /BRAIN reload restore/i.test(t.detail))).toBe(
      true
    );
  });

  it('persistRunningRobotsForReload skips robots with open trades', async () => {
    await startRobotSession({
      account_id: 17,
      epic: 'GOLD',
      lot_size: 0.5,
      entry_enabled: true,
    });
    const id = robotIdFor(17, 'GOLD');
    _patchRobotSessionForTests(id, {
      open_side: 'BUY',
      deal_id: 'deal-1',
      mode: 'MANAGE',
    });
    const n = persistRunningRobotsForReload();
    expect(n).toBe(0);
    const disk = JSON.parse(fs.readFileSync(runningRobotsSnapshotPath(), 'utf8')) as {
      robots: unknown[];
    };
    expect(disk.robots).toEqual([]);
  });
});

function stubExit(): { code: number | null; restore: () => void } {
  const state = { code: null as number | null };
  const orig = process.exit;
  // @ts-expect-error test stub
  process.exit = ((code?: number) => {
    state.code = code ?? 0;
  }) as typeof process.exit;
  return {
    get code() {
      return state.code;
    },
    restore: () => {
      process.exit = orig;
    },
  };
}
