import { describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  readFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('news_window DualPersist heal', () => {
  it('MemoryPersist primary heals wiped news_window sidecar and keeps hard-gate', async () => {
    const {
      MemoryPersist,
      setPersistClient,
      persistNewsWindowState,
    } = await import('../persist.js');
    const { DualPersist } = await import('../dualPersist.js');
    const { FilePersist } = await import('../filePersist.js');
    const {
      saveNewsWindow,
      hydrateNewsWindowFromPersist,
      newsBlocksEntries,
    } = await import('../newsGate.js');
    const dir = mkdtempSync(join(tmpdir(), 'master-news-pg-heal-'));
    const prevState = process.env.MASTER_STATE_DIR;
    const prevImpact = process.env.MASTER_NEWS_IMPACT;
    const prevFilter = process.env.MASTER_NEWS_FILTER;
    process.env.MASTER_STATE_DIR = dir;
    delete process.env.MASTER_NEWS_IMPACT;
    delete process.env.MASTER_NEWS_FILTER;
    const primary = new MemoryPersist();
    try {
      setPersistClient(new DualPersist(primary, new FilePersist(dir)));
      expect(
        saveNewsWindow({
          impact: 'high',
          until_ms: Date.now() + 60 * 60_000,
          active: true,
          detail: 'unit_heal',
        })
      ).toBe(true);
      expect(existsSync(join(dir, 'news_window.json'))).toBe(true);
      await persistNewsWindowState({
        impact: 'high',
        until_ms: Date.now() + 60 * 60_000,
        active: true,
        detail: 'unit_heal',
        saved_at_ms: Date.now(),
      });
      expect(primary.newsWindowPayload?.impact).toBe('high');
      setPersistClient(null);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      setPersistClient(new DualPersist(primary, new FilePersist(dir)));
      expect(existsSync(join(dir, 'news_window.json'))).toBe(false);
      const healed = await hydrateNewsWindowFromPersist(dir);
      expect(healed.restored).toBe(true);
      expect(existsSync(join(dir, 'news_window.json'))).toBe(true);
      const raw = JSON.parse(
        readFileSync(join(dir, 'news_window.json'), 'utf8')
      );
      expect(raw.impact).toBe('high');
      expect(newsBlocksEntries(true, Date.now(), 'GOLD').blocked).toBe(true);
    } finally {
      setPersistClient(null);
      if (prevState === undefined) delete process.env.MASTER_STATE_DIR;
      else process.env.MASTER_STATE_DIR = prevState;
      if (prevImpact === undefined) delete process.env.MASTER_NEWS_IMPACT;
      else process.env.MASTER_NEWS_IMPACT = prevImpact;
      if (prevFilter === undefined) delete process.env.MASTER_NEWS_FILTER;
      else process.env.MASTER_NEWS_FILTER = prevFilter;
      try {
        unlinkSync(join(dir, 'news_window.json'));
      } catch {
        /* ignore */
      }
    }
  });
});
