import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('P3 runtime call-chain wiring', () => {
  it('robotCycle uses Strategy→Exit money path (evaluateStrategy → enterTrade)', () => {
    const src = readFileSync(join(process.cwd(), 'src/services/robotDesk.ts'), 'utf8');
    // Authoritative opener after architecture merge — not the AAA tradePipeline alternate.
    expect(src).toContain("import { evaluateStrategy, strategyToDecisionCode } from '../vs-core/strategyCore.js'");
    expect(src).toContain('evaluateStrategy({');
    expect(src).toContain('await enterTrade(');
    expect(src).toContain('buildMoneyPathRisk(');
    expect(src).toContain('evaluateRisk(');
    expect(src).toContain("import { decideBestOutcomeExit, favorableMove } from './exitManage.js'");
    // tradePipeline remains available as a diagnostic/AAA module, not the live opener
    expect(src).not.toContain("import { runTradePipeline } from './tradePipeline.js'");
  });

  it('tradePipeline + orderLifecycle modules exist for AAA health/desk tooling', () => {
    const pipe = readFileSync(join(process.cwd(), 'src/services/tradePipeline.ts'), 'utf8');
    const life = readFileSync(join(process.cwd(), 'src/services/orderLifecycle.ts'), 'utf8');
    expect(pipe).toContain('export function runTradePipeline');
    expect(life).toContain('export function createManagedOrder');
    expect(life).toContain('export async function submitManagedOrder');
  });
});
