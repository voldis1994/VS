import { describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  readFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureOperatorMetaFromStateDir } from '../filePersist.js';

describe('operator_meta newer sidecar parity', () => {
  it('ensureOperatorMetaFromStateDir restores monitoring/spread/news/fanout/trade_ack', () => {
    const dir = mkdtempSync(join(tmpdir(), 'master-opmeta-parity-'));
    const prev = process.env.MASTER_STATE_DIR;
    process.env.MASTER_STATE_DIR = dir;
    try {
      mkdirSync(dir, { recursive: true });
      const monitoring = {
        timestamp_utc: new Date().toISOString(),
        cycle_latency_ms: 42,
        relative_spread: 1.2,
        entry_block_reason: 'alert:DATA_STALE',
        active_alerts: [{ code: 'DATA_STALE', level: 'WARN', message: 'x' }],
      };
      const spread = { lookback: 20, history: [0.3, 0.35, 0.4, 0.38], ts: new Date().toISOString() };
      const news = {
        impact: 'high',
        until_ms: Date.now() + 60_000,
        active: true,
        detail: 'opmeta',
      };
      const fanout = {
        attempted: true,
        subscribers: 2,
        ok_count: 2,
        fail_count: 0,
        detail: 'ok=2/2',
        journaled_count: 2,
      };
      const tradeAck = {
        'cmd-1': {
          command_id: 'cmd-1',
          intent_id: 'i1',
          action: 'OPEN',
          side: 'BUY',
          volume: 0.1,
          epic: 'EURUSD',
          ack_status: 'SUCCESS',
          ticket: 'T-1',
          fill_price: 1.1,
          sl: 1.0,
          tp: 1.2,
          reason: 'ACK',
          ts_intent: new Date().toISOString(),
          ts_ack: new Date().toISOString(),
        },
      };
      writeFileSync(
        join(dir, 'master_state.json'),
        JSON.stringify({
          opportunities: [],
          outcomes: [],
          positions: [],
          intents: [],
          operator_meta: {
            monitoring_snapshot: monitoring,
            spread_history: spread,
            news_window: news,
            client_fanout: fanout,
            trade_ack_journal: tradeAck,
          },
        })
      );
      expect(ensureOperatorMetaFromStateDir(dir)).toBe(true);
      expect(existsSync(join(dir, 'monitoring_snapshot.json'))).toBe(true);
      expect(existsSync(join(dir, 'spread_history.json'))).toBe(true);
      expect(existsSync(join(dir, 'news_window.json'))).toBe(true);
      expect(existsSync(join(dir, 'client_fanout.json'))).toBe(true);
      expect(existsSync(join(dir, 'trade_ack_journal.json'))).toBe(true);
      expect(
        JSON.parse(readFileSync(join(dir, 'monitoring_snapshot.json'), 'utf8'))
          .entry_block_reason
      ).toBe('alert:DATA_STALE');
      expect(
        JSON.parse(readFileSync(join(dir, 'news_window.json'), 'utf8')).impact
      ).toBe('high');
      expect(
        JSON.parse(readFileSync(join(dir, 'client_fanout.json'), 'utf8')).ok_count
      ).toBe(2);
      expect(
        JSON.parse(readFileSync(join(dir, 'trade_ack_journal.json'), 'utf8'))[
          'cmd-1'
        ].ticket
      ).toBe('T-1');
      // Wipe and restore again
      for (const f of [
        'monitoring_snapshot.json',
        'spread_history.json',
        'news_window.json',
        'client_fanout.json',
        'trade_ack_journal.json',
      ]) {
        unlinkSync(join(dir, f));
      }
      expect(ensureOperatorMetaFromStateDir(dir)).toBe(true);
      expect(existsSync(join(dir, 'spread_history.json'))).toBe(true);
      expect(
        JSON.parse(readFileSync(join(dir, 'spread_history.json'), 'utf8')).history
          .length
      ).toBeGreaterThanOrEqual(3);
    } finally {
      if (prev === undefined) delete process.env.MASTER_STATE_DIR;
      else process.env.MASTER_STATE_DIR = prev;
    }
  });
});
