import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { installFilePersist } from '../filePersist.js';
import { setPersistClient, MemoryPersist } from '../persist.js';
import { DualPersist } from '../dualPersist.js';
import { setJournalMirror } from '../journalMirror.js';
import { resolvePersistBackend } from '../persistBackend.js';
import { logDecisionEvent } from '../decisionJournal.js';
import { logTradeEvent } from '../tradeEventJournal.js';
import { masterRuntime } from '../runtime.js';

describe('journal audit dashboard provenance', () => {
  const prevDir = process.env.MASTER_STATE_DIR;
  const masterRoot = join(__dirname, '..');
  const dashboardPages = join(__dirname, '../../../../dashboard/src/pages');

  afterEach(() => {
    setPersistClient(null);
    setJournalMirror(null);
    if (prevDir === undefined) delete process.env.MASTER_STATE_DIR;
    else process.env.MASTER_STATE_DIR = prevDir;
    delete process.env.MASTER_GATES_DIR;
  });

  it('resolvePersistBackend labels dual/file/memory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vs-pback-'));
    const file = installFilePersist(dir);
    expect(resolvePersistBackend(file)).toBe('file');
    const dual = new DualPersist(new MemoryPersist(), file);
    expect(resolvePersistBackend(dual)).toBe('dual');
    expect(resolvePersistBackend(new MemoryPersist())).toBe('memory');
  });

  it('status emits persist_backend + journal_audit after file seed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vs-jaud-'));
    process.env.MASTER_STATE_DIR = dir;
    process.env.MASTER_GATES_DIR = dir;
    installFilePersist(dir);
    logDecisionEvent({
      kind: 'WAIT',
      epic: 'GOLD',
      mode: 'PAPER',
      opportunity_id: 'opp-ja-1',
    });
    logTradeEvent({
      event: 'OPEN',
      broker: 'PAPER',
      epic: 'GOLD',
      ok: true,
      detail: 'ja_seed',
      position_id: 'pos-ja-1',
      opportunity_id: 'opp-ja-1',
    });
    await new Promise((r) => setTimeout(r, 20));
    const st = masterRuntime.status();
    expect(st.persist_backend).toBe('file');
    expect(st.journal_audit.decisions).toBeGreaterThanOrEqual(1);
    expect(st.journal_audit.trades).toBeGreaterThanOrEqual(1);
    expect(st.journal_audit.decision_sidecar).toBe(true);
    expect(st.journal_audit.trade_sidecar).toBe(true);
  });

  it('MasterPage + verify strings for Journal audit', () => {
    const page = join(dashboardPages, 'MasterPage.tsx');
    expect(existsSync(page)).toBe(true);
    const body = readFileSync(page, 'utf8');
    expect(body).toMatch(/persist_backend/);
    expect(body).toMatch(/journal_audit/);
    expect(body).toMatch(/Journal audit/);
    const runtime = readFileSync(join(masterRoot, 'runtime.ts'), 'utf8');
    expect(runtime).toMatch(/persist_backend:/);
    expect(runtime).toMatch(/journal_audit:/);
    expect(runtime).toMatch(/healed_from_persist/);
  });
});
