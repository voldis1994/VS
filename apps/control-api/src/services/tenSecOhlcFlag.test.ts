import { describe, expect, it } from 'vitest';
import { TEN_SEC_OHLC_ENABLED, tenSecOhlcStatusLine } from './tenSecOhlcFlag.js';
import { publicOhlc10sOff } from './tenSecondOhlc.js';

describe('10s OHLC kill-switch', () => {
  it('defaults OFF until TEN_SEC_OHLC_ENABLED=1', () => {
    // Default in this environment: unset → OFF (user request).
    expect(TEN_SEC_OHLC_ENABLED).toBe(false);
    expect(tenSecOhlcStatusLine()).toMatch(/10s OHLC OFF/i);
  });

  it('public snapshot market=OFF when disabled', () => {
    expect(publicOhlc10sOff().market).toBe('OFF');
  });

  it('status line says EARLY uses 1m when 10s OFF (not dead wait-only-5m)', () => {
    expect(tenSecOhlcStatusLine()).toMatch(/10s OHLC OFF/i);
    expect(tenSecOhlcStatusLine()).toMatch(/1m/i);
    expect(tenSecOhlcStatusLine()).toMatch(/EARLY/i);
  });
});
