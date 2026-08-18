import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerLiveControlRoutes } from './liveControl.js';

describe('liveControl module (boot)', () => {
  it('exists at the path index.ts imports', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    expect(existsSync(join(here, 'liveControl.ts'))).toBe(true);
  });

  it('exports registerLiveControlRoutes', () => {
    expect(typeof registerLiveControlRoutes).toBe('function');
  });
});
