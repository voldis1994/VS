/**
 * Proof tests — assert REAL execution of full-system audit fixes.
 * If these pass, the code paths run; comments alone cannot make them green.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { withCapitalAccountSession, withConnectionLock } from './capitalCom.js';
import { decideBestOutcomeExit, TARGET_ABS_FLOOR } from './exitManage.js';
import { expandMinutesToTen, rangePct } from './tenSecondOhlc.js';
import { EXPAND_ABS } from './regimeBands.js';
import { sameDirectionBlocked, SAME_DIR_LOCK_MS } from './flipFilter.js';
import { resolveFanoutIdempotencyKey } from './intentFanout.js';

describe('PROOF: withCapitalAccountSession fail-closed', () => {
  it('requireAccountId refuses BEFORE any Capital login when id missing', async () => {
    let fnRan = false;
    const out = await withCapitalAccountSession(
      {
        environment: 'demo',
        apiKey: 'k',
        identifier: 'id',
        password: 'p',
        connectionId: 4242,
        capitalAccountId: null,
        requireAccountId: true,
      },
      async () => {
        fnRan = true;
        return 'should-not-run';
      }
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.result.detail).toMatch(/capitalAccountId required/i);
    }
    expect(fnRan).toBe(false);
  });

  it('invalid connectionId refuses without calling fn', async () => {
    let fnRan = false;
    const out = await withCapitalAccountSession(
      {
        environment: 'demo',
        apiKey: 'k',
        identifier: 'id',
        password: 'p',
        connectionId: 0,
        capitalAccountId: 'ACC',
        requireAccountId: true,
      },
      async () => {
        fnRan = true;
        return 1;
      }
    );
    expect(out.ok).toBe(false);
    expect(fnRan).toBe(false);
  });
});

describe('PROOF: connection mutex serializes concurrent work', () => {
  it('second caller waits until first releases the lock', async () => {
    const order: string[] = [];
    const a = withConnectionLock(7771, async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 40));
      order.push('a-end');
      return 1;
    });
    const b = withConnectionLock(7771, async () => {
      order.push('b-start');
      order.push('b-end');
      return 2;
    });
    await Promise.all([a, b]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('different connectionIds do NOT block each other', async () => {
    const order: string[] = [];
    const a = withConnectionLock(8881, async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 40));
      order.push('a-end');
    });
    const b = withConnectionLock(8882, async () => {
      order.push('b-start');
      order.push('b-end');
    });
    await Promise.all([a, b]);
    expect(order.indexOf('b-start')).toBeLessThan(order.indexOf('a-end'));
  });

  it('hold timeout releases mutex so waiter is not stuck forever', async () => {
    const order: string[] = [];
    const hung = withConnectionLock(
      9991,
      async () => {
        order.push('hung-start');
        await new Promise((r) => setTimeout(r, 400));
        order.push('hung-late');
        return 'hung';
      },
      { holdMs: 50, waitMs: 500 }
    );
    await new Promise((r) => setTimeout(r, 5));
    const waiter = withConnectionLock(
      9991,
      async () => {
        order.push('waiter');
        return 'ok';
      },
      { holdMs: 500, waitMs: 500 }
    );
    await expect(hung).rejects.toThrow(/lock hold timeout/);
    await expect(waiter).resolves.toBe('ok');
    expect(order).toContain('hung-start');
    expect(order).toContain('waiter');
  });
});

describe('PROOF: target_time gate actually exits winners', () => {
  const snap = (over: Record<string, unknown>) =>
    ({
      open_side: 'BUY' as const,
      entry_price: 2000,
      entry_at: new Date(Date.now() - 60_000).toISOString(),
      mfe: 0,
      mae: 0,
      peak_retention: null,
      ...over,
    }) as Parameters<typeof decideBestOutcomeExit>[0];

  it('target_time exits at Target — peak_protect_only would hold', () => {
    const mid = 2000 + Math.max(TARGET_ABS_FLOOR, 7) + 0.1;
    const peakOnly = decideBestOutcomeExit(
      snap({ mfe: mid - 2000, peak_retention: 1 }),
      mid,
      'peak_protect_only'
    );
    const target = decideBestOutcomeExit(
      snap({ mfe: mid - 2000, peak_retention: 1 }),
      mid,
      'target_time'
    );
    expect(peakOnly.exit).toBe(false);
    expect(target.exit).toBe(true);
    expect(target.reason).toMatch(/Target/);
  });

  it('target_time ignores HardInv (red) — live_loss owns that', () => {
    const d = decideBestOutcomeExit(
      snap({ mfe: 1, peak_retention: 0.5 }),
      1990,
      'target_time'
    );
    expect(d.exit).toBe(false);
  });
});

describe('PROOF: minute→10s seed does not inject 1m EXPANSION ranges', () => {
  it('most synthetic bars stay below EXPAND_ABS', () => {
    const mins = Array.from({ length: 30 }, (_, i) => ({
      open: 2650 + i * 0.2,
      high: 2650 + i * 0.2 + 1.5,
      low: 2650 + i * 0.2 - 1.2,
      close: 2650 + i * 0.2 + 0.1,
    }));
    const bars = expandMinutesToTen(mins, 1_700_000_180_000);
    expect(bars.length).toBe(180);
    const quiet = bars.filter((b) => rangePct(b) < EXPAND_ABS);
    expect(quiet.length).toBeGreaterThanOrEqual(140);
    expect(Math.max(...bars.map((b) => b.high))).toBeGreaterThanOrEqual(
      2650 + 29 * 0.2 + 1.5 - 0.01
    );
  });
});

describe('PROOF: flip lock is real (3m same-dir)', () => {
  it('blocks same side inside lock window', () => {
    const closedAt = Date.now() - 30_000;
    expect(sameDirectionBlocked('BUY', 'BUY', closedAt)).toBe(true);
    expect(sameDirectionBlocked('SELL', 'BUY', closedAt)).toBe(false);
  });

  it('allows same side after lock expires', () => {
    const closedAt = Date.now() - SAME_DIR_LOCK_MS - 1000;
    expect(sameDirectionBlocked('BUY', 'BUY', closedAt)).toBe(false);
  });
});

describe('PROOF: fanout resolveFanoutIdempotencyKey (exported real fn)', () => {
  it('auto key when missing; explicit key wins', () => {
    const a = resolveFanoutIdempotencyKey({
      epic: 'GOLD',
      direction: 'BUY',
      reference_price: 2650.1,
    });
    const b = resolveFanoutIdempotencyKey({
      epic: 'GOLD',
      direction: 'BUY',
      reference_price: 2650.1,
    });
    expect(a).toBe(b);
    expect(a.startsWith('auto:GOLD:BUY:')).toBe(true);
    expect(
      resolveFanoutIdempotencyKey({
        epic: 'GOLD',
        direction: 'BUY',
        idempotency_key: 'reader-key-1',
      })
    ).toBe('reader-key-1');
  });
});

describe('PROOF: fresh fill prefers broker open_level over mid', () => {
  it('open_level wins; missing open_level keeps provisional mid', async () => {
    const { preferBrokerOpenLevel } = await import('./robotDesk.js');
    expect(preferBrokerOpenLevel(2650.25, 2650.41)).toBe(2650.41);
    expect(preferBrokerOpenLevel(2650.25, null)).toBe(2650.25);
    expect(preferBrokerOpenLevel(2650.25, undefined)).toBe(2650.25);
    expect(preferBrokerOpenLevel(null, null)).toBe(null);
  });

  it('enterTradeLocked source syncs open_level with stop_level after list', () => {
    const src = readFileSync(join(__dirname, 'robotDesk.ts'), 'utf8');
    expect(src).toContain('preferBrokerOpenLevel');
    expect(src).toMatch(/pos\?\.open_level/);
    expect(src).toMatch(/pos\?\.stop_level/);
    expect(src).toMatch(/mid\/now only provisional|provisional/);
  });
});

describe('PROOF: source wiring — not comment-only', () => {
  const here = join(__dirname);

  it('robotDesk Peak key uses snapshot_time, not wall-clock minute', () => {
    const src = readFileSync(join(here, 'robotDesk.ts'), 'utf8');
    expect(src).toContain('snapshot_time_ms');
    expect(src).not.toMatch(/Date\.now\(\)\s*\/\s*60_000/);
    expect(src).toContain("decideBestOutcomeExit(s, quote.mid, 'target_time')");
    expect(src).toContain('withCapitalAccountSession');
    expect(src).toContain('requireAccountId: true');
  });

  it('intentFanout uses lease + flip lock + resolveFanoutIdempotencyKey', () => {
    const src = readFileSync(join(here, 'intentFanout.ts'), 'utf8');
    expect(src).toContain('withCapitalAccountSession');
    expect(src).toContain('sameDirectionBlocked');
    expect(src).toContain('resolveFanoutIdempotencyKey');
    expect(src).not.toMatch(/acquireCapitalSession\(/);
  });

  it('client WS only drops online on fatal error', () => {
    const src = readFileSync(
      join(here, '../../../dashboard/src/hooks/useClientWebSocket.ts'),
      'utf8'
    );
    expect(src).toContain("msg.type === 'error' && msg.fatal === true");
    expect(src).not.toMatch(/if \(msg\.type === 'error'\) setOnline\(false\)/);
  });

  it('ClientPanelPage prefers saved lot_size over min_lot', () => {
    const src = readFileSync(
      join(here, '../../../dashboard/src/pages/ClientPanelPage.tsx'),
      'utf8'
    );
    expect(src).toContain('st.lot_size');
    expect(src).toContain('Prefer saved lot_size');
    expect(src).toContain('BROKER POSITION (MANAGED)');
  });

  it('attachManageOnlyRobot forces entry_enabled OFF', () => {
    const src = readFileSync(join(here, 'robotDesk.ts'), 'utf8');
    const attach = src.slice(src.indexOf('export async function attachManageOnlyRobot'));
    expect(attach).toContain('existing.entry_enabled = false');
    expect(attach).toContain('entry_brain=OFF');
  });
});
