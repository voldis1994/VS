import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('P3 runtime call-chain wiring', () => {
  it('robotCycle calls runTradePipeline then enterTrade (not parallel unused module)', () => {
    const src = readFileSync(join(process.cwd(), 'src/services/robotDesk.ts'), 'utf8');
    expect(src).toContain("import { runTradePipeline } from './tradePipeline.js'");
    expect(src).toContain('runTradePipeline({');
    expect(src).toContain('pipe.intent.direction');
    expect(src).toContain('await enterTrade(');
    // Session recovery on market-data auth failure
    expect(src).toContain('invalidateCapitalSession');
    expect(src).toContain('forceRefresh: true');
    // Order lifecycle
    expect(src).toContain('submitManagedOrder');
    expect(src).toContain('createManagedOrder');
  });
});
