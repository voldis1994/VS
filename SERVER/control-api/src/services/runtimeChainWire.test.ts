import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('P3 runtime call-chain wiring', () => {
  it('robotCycle executes queued C++ calc then 10s Node fallback — never evaluateStrategy', () => {
    const src = readFileSync(join(process.cwd(), 'src/services/robotDesk.ts'), 'utf8');
    expect(src).toContain('pending_calc');
    expect(src).toContain('await enterTrade(');
    expect(src).toContain('releaseGhostIntents');
    expect(src).toContain('buildMoneyPathRisk(');
    expect(src).toContain('evaluateRisk(');
    expect(src).toContain('decideBestOutcomeExitFull');
    expect(src).toContain('decideLiveBestOutcomeExit');
    expect(src).toContain('resolveLiveManageSignal');
    expect(src).toContain('canOptimizationClose');
    expect(src).toContain('initBestOutcomeTrack');
    expect(src).toContain('decideExternalFlatClear');
    expect(src).toContain('describeExternalFlatClose');
    expect(src).toContain('finalizeLocalClose');
    expect(src).not.toContain('Broker flat on this epic — trade closed');
    const exitSrc = readFileSync(join(process.cwd(), 'src/services/exitManage.ts'), 'utf8');
    expect(exitSrc).toContain('evaluateBestOutcome');
    expect(exitSrc).toContain('Best Outcome');
    expect(exitSrc).not.toContain("action: 'TRAIL'");
    expect(src).not.toContain('tryPostBeProfitTrail');
    expect(src).not.toContain('PROFIT GUARD');
    expect(exitSrc).not.toContain('HardInvalidation');
    expect(exitSrc).toContain('0.00 is not Best Outcome');
    expect(src).toContain('waiting confirms/C++');
    expect(src).toContain('EXEC plan READY');
    expect(src).toContain('entryPlanReady');
    expect(src).toContain('this 10s already filled');
    expect(src).toContain('EXEC Node hands');
    expect(src).toContain('detectStaleQuoteAdverse');
    expect(src).not.toContain('evaluateStrategy({');
    expect(src).not.toContain("import { runTradePipeline } from './tradePipeline.js'");
    expect(src).toContain('SAFETY SL attached');
    expect(src).toContain('SAFETY_SL_REL');
    expect(src).toContain('hasMeaningfulProfit');
    expect(src).toContain('planDirection:');
    const cap = readFileSync(join(process.cwd(), 'src/services/capitalCom.ts'), 'utf8');
    expect(cap).toContain('export const SAFETY_SL_REL = 0.004 / 3');
    const desk = readFileSync(join(process.cwd(), 'src/services/deskEntry.ts'), 'utf8');
    expect(desk).toContain('decideEntryFrom10sRegime');
    expect(desk).toContain('detectCapitalLagLead');
  });

  it('tradePipeline + orderLifecycle modules exist for AAA health/desk tooling', () => {
    const pipe = readFileSync(join(process.cwd(), 'src/services/tradePipeline.ts'), 'utf8');
    const life = readFileSync(join(process.cwd(), 'src/services/orderLifecycle.ts'), 'utf8');
    expect(pipe).toContain('export function runTradePipeline');
    expect(life).toContain('export function createManagedOrder');
    expect(life).toContain('export async function submitManagedOrder');
  });
});
