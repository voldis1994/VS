import { describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  unlinkSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('news_calendar DualPersist heal', () => {
  it('MemoryPersist primary heals wiped calendar and keeps high-impact block', async () => {
    const {
      MemoryPersist,
      setPersistClient,
      persistNewsCalendarState,
    } = await import('../persist.js');
    const { DualPersist } = await import('../dualPersist.js');
    const { FilePersist } = await import('../filePersist.js');
    const {
      hydrateNewsCalendarFromPersist,
      clearNewsCalendarCacheForTest,
      isNewsCalendarBlocked,
      setNewsCalendarCacheForTest,
    } = await import('../newsCalendar.js');
    const dir = mkdtempSync(join(tmpdir(), 'master-news-cal-pg-heal-'));
    const prevState = process.env.MASTER_STATE_DIR;
    process.env.MASTER_STATE_DIR = dir;
    const primary = new MemoryPersist();
    const now = Date.now();
    try {
      setPersistClient(new DualPersist(primary, new FilePersist(dir)));
      const events = [
        {
          title: 'FOMC Statement',
          country: 'USD',
          date: new Date(now + 5 * 60_000).toISOString(),
          impact: 'High',
        },
      ];
      setNewsCalendarCacheForTest(events, now);
      await persistNewsCalendarState({
        events,
        fetched_at_ms: now,
        saved_at_ms: Date.now(),
      });
      // Force disk write via FilePersist flush path
      expect(primary.newsCalendarPayload?.events?.length).toBe(1);
      setPersistClient(null);
      clearNewsCalendarCacheForTest();
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      setPersistClient(new DualPersist(primary, new FilePersist(dir)));
      expect(existsSync(join(dir, 'news_calendar.json'))).toBe(false);
      const healed = await hydrateNewsCalendarFromPersist(dir);
      expect(healed.restored).toBe(true);
      expect(healed.count).toBeGreaterThanOrEqual(1);
      expect(existsSync(join(dir, 'news_calendar.json'))).toBe(true);
      expect(
        isNewsCalendarBlocked({
          symbol: 'GOLD',
          nowMs: now,
          minutesBefore: 30,
          minutesAfter: 15,
          minImpact: 'High',
        }).blocked
      ).toBe(true);
    } finally {
      setPersistClient(null);
      clearNewsCalendarCacheForTest();
      if (prevState === undefined) delete process.env.MASTER_STATE_DIR;
      else process.env.MASTER_STATE_DIR = prevState;
      try {
        unlinkSync(join(dir, 'news_calendar.json'));
      } catch {
        /* ignore */
      }
    }
  });
});
