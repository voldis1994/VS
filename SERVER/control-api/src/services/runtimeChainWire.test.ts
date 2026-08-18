import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('P3 runtime call-chain wiring', () => {
  it('robotCycle executes queued C++ calc then Capital — Node is hands only', () => {
    const src = readFileSync(join(process.cwd(), 'src/services/robotDesk.ts'), 'utf8');
    expect(src).toContain('pending_calc');
    expect(src).toContain('await enterTrade(');
    expect(src).toContain('buildMoneyPathRisk(');
    expect(src).toContain('evaluateRisk(');
    expect(src).toContain("import { decideBestOutcomeExit, favorableMove } from './exitManage.js'");
    expect(src).toContain('waiting for C++ calc EntryReady');
    expect(src).not.toContain('evaluateStrategy({');
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
