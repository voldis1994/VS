import { describe, expect, it } from 'vitest';
import {
  getDeskClientId,
  resolveDeskClientId,
  runWithDeskClient,
  runWithDeskClientAsync,
} from './deskClientScope.js';

describe('deskClientScope', () => {
  it('resolves ALS client id inside runWithDeskClient', () => {
    expect(getDeskClientId()).toBeNull();
    const got = runWithDeskClient(7, () => resolveDeskClientId());
    expect(got).toBe(7);
    expect(getDeskClientId()).toBeNull();
  });

  it('explicit id beats ALS', async () => {
    await runWithDeskClientAsync(3, async () => {
      expect(resolveDeskClientId(9)).toBe(9);
      expect(resolveDeskClientId()).toBe(3);
    });
  });
});
