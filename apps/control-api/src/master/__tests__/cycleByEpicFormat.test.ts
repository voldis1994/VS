import { describe, expect, it } from 'vitest';
import {
  cyclesByEpicTone,
  formatCyclesByEpicDetail,
} from '../cycleByEpicFormat.js';

describe('formatCyclesByEpicDetail', () => {
  it('formats multi-epic rows with active mark', () => {
    const detail = formatCyclesByEpicDetail(
      {
        SILVER: {
          market_setup: { status: 'WATCH', side: 'SELL', kind: 'CONTINUATION' },
          decision_kind: 'BLOCK',
        },
        GOLD: {
          market_setup: { status: 'ARMED', side: 'BUY', kind: 'CONTINUATION' },
          decision_kind: 'WAIT',
        },
      },
      'GOLD'
    );
    expect(detail).toMatch(/\*GOLD:ARMED BUY · WAIT/);
    expect(detail).toMatch(/SILVER:WATCH SELL · BLOCK/);
    expect(cyclesByEpicTone({ GOLD: {}, SILVER: {} })).toBe('ok');
  });

  it('returns dash for empty', () => {
    expect(formatCyclesByEpicDetail(null)).toBe('—');
    expect(formatCyclesByEpicDetail({})).toBe('—');
    expect(cyclesByEpicTone({})).toBe('');
    expect(cyclesByEpicTone({ GOLD: {} })).toBe('warn');
  });
});
