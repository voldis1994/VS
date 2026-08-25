import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendClosedTrade,
  appendOpenEvent,
  newTradeId,
  tradeJournalPath,
  type JournalOpenSnap,
} from './tradeJournal.js';

function sampleOpen(partial?: Partial<JournalOpenSnap>): JournalOpenSnap {
  return {
    trade_id: newTradeId('TEST'),
    source: 'desk',
    opened_at: '2026-08-25T12:00:00.000Z',
    account_id: 1,
    client_id: 2,
    client_name: 'TEST',
    account_name: 'ACC',
    robot_id: '1:GOLD',
    environment: 'demo',
    epic: 'GOLD',
    display_name: 'Gold',
    side: 'BUY',
    lot_size: 0.1,
    entry_price: 4500,
    safety_sl: 4491,
    deal_id: 'D1',
    deal_reference: 'R1',
    regime: 'TREND_UP',
    setup_type: 'BREAKOUT',
    zone_kind: 'BOX',
    zone_high: 4502,
    zone_low: 4496,
    zone_detail: 'BOX 4496–4502',
    open_reason: 'TREND_UP · ZONE BREAKOUT ↑',
    feed_source: 'MULTI',
    feed_agreement: 'OK',
    feed_contributing: 2,
    feed_sender_count: 4,
    lead_label: 'Yahoo (LEAD)',
    ohlc_last: 'O4500 C4501',
    entry_enabled: true,
    ...partial,
  };
}

describe('tradeJournal', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-journal-'));
    process.env.TRADE_JOURNAL_DIR = tmp;
    delete process.env.TRADE_JOURNAL_PATH;
  });

  afterEach(() => {
    delete process.env.TRADE_JOURNAL_DIR;
    delete process.env.TRADE_JOURNAL_PATH;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('writes Excel CSV with open+close reasons', () => {
    const open = sampleOpen();
    appendOpenEvent(open);
    const closed = appendClosedTrade({
      open,
      closed_at: '2026-08-25T12:05:00.000Z',
      exit_price: 4508,
      exit_mid: 4508,
      close_reason: 'PeakProtection · keep 40% of MFE',
      mfe: 12,
      mae: -1,
      peak_retention: 0.66,
      unrealized_at_close: 8,
      regime_at_exit: 'TREND_UP',
      zone_detail_at_exit: 'BOX still valid',
      was_loss: false,
      hold_sec: 300,
      pnl_pts: 8,
    });
    expect(closed.ok).toBe(true);
    const file = tradeJournalPath();
    expect(fs.existsSync(file)).toBe(true);
    const text = fs.readFileSync(file, 'utf8');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain('open_reason');
    expect(text).toContain('close_reason');
    expect(text).toContain('ZONE BREAKOUT');
    expect(text).toContain('PeakProtection');
  });
});
