import { describe, expect, it } from 'vitest';
import { parseCapitalCreatedAt } from './capitalCom.js';
import { preferBrokerEntryAt } from './robotDesk.js';

describe('parseCapitalCreatedAt', () => {
  it('parses createdDateUTC without Z as UTC', () => {
    const iso = parseCapitalCreatedAt('2022-04-05T09:46:01.872');
    expect(iso).toBe('2022-04-05T09:46:01.872Z');
  });

  it('keeps explicit Z', () => {
    expect(parseCapitalCreatedAt('2022-04-05T09:46:01.872Z')).toBe(
      '2022-04-05T09:46:01.872Z'
    );
  });

  it('returns null for empty', () => {
    expect(parseCapitalCreatedAt(null)).toBeNull();
    expect(parseCapitalCreatedAt('')).toBeNull();
  });
});

describe('preferBrokerEntryAt — TimeDecay survives restart', () => {
  it('uses broker created_at when local is missing', () => {
    expect(preferBrokerEntryAt(null, '2022-04-05T09:46:01.872Z')).toBe(
      '2022-04-05T09:46:01.872Z'
    );
  });

  it('replaces recovery "now" with older broker open time', () => {
    const broker = '2022-04-05T09:46:01.872Z';
    const recoveredNow = '2022-04-05T10:00:00.000Z'; // restart ~14m later
    expect(preferBrokerEntryAt(recoveredNow, broker)).toBe(broker);
  });

  it('prefers broker even when local is a fresh fill stamp a few seconds later', () => {
    const local = '2022-04-05T09:46:05.000Z';
    const broker = '2022-04-05T09:46:01.872Z';
    expect(preferBrokerEntryAt(local, broker)).toBe(broker);
  });

  it('falls back to now when nothing known', () => {
    const now = '2022-04-05T12:00:00.000Z';
    expect(preferBrokerEntryAt(null, null, now)).toBe(now);
  });
});
