import { afterEach, describe, expect, it } from 'vitest';
import {
  _setEntryFilterLevelForTests,
  _setTradeOpenAtStartForTests,
  entryFilterLevel,
  entryFilterLevelLabel,
  entryFlipLockEnabled,
  entrySameDirConfirmEnabled,
  entrySpikeBlockEnabled,
  entryStructureEnabled,
  tradeOpenAtStart,
} from './tradeOpenPolicy.js';
import { defaultDeskCalibration, setDeskCalibration } from './deskCalibration.js';

afterEach(() => {
  _setTradeOpenAtStartForTests(null);
  _setEntryFilterLevelForTests(null);
  setDeskCalibration(defaultDeskCalibration());
});

describe('entry filter ladder', () => {
  it('level 0 is open — all soft filters off', () => {
    _setEntryFilterLevelForTests(0);
    expect(tradeOpenAtStart()).toBe(true);
    expect(entryFlipLockEnabled()).toBe(false);
    expect(entryStructureEnabled()).toBe(false);
    expect(entrySameDirConfirmEnabled()).toBe(false);
    expect(entrySpikeBlockEnabled()).toBe(false);
  });

  it('level 1 enables flip lock only', () => {
    _setEntryFilterLevelForTests(1);
    expect(tradeOpenAtStart()).toBe(false);
    expect(entryFlipLockEnabled()).toBe(true);
    expect(entryStructureEnabled()).toBe(false);
    expect(entrySameDirConfirmEnabled()).toBe(false);
  });

  it('level 2 enables structure', () => {
    _setEntryFilterLevelForTests(2);
    expect(entryStructureEnabled()).toBe(true);
    expect(entrySameDirConfirmEnabled()).toBe(false);
  });

  it('level 3 is strict', () => {
    _setEntryFilterLevelForTests(3);
    expect(entrySameDirConfirmEnabled()).toBe(true);
    expect(entrySpikeBlockEnabled()).toBe(true);
    expect(entryFilterLevelLabel(3)).toMatch(/STRICT/i);
  });

  it('reads level from desk calibration when no override', () => {
    setDeskCalibration({ entry_filter_level: 2 });
    expect(entryFilterLevel()).toBe(2);
    expect(entryStructureEnabled()).toBe(true);
  });

  it('legacy open override still works', () => {
    _setTradeOpenAtStartForTests(true);
    expect(tradeOpenAtStart()).toBe(true);
    _setTradeOpenAtStartForTests(false);
    expect(entryFilterLevel()).toBe(3);
  });
});
