/**
 * One autonomous cycle: analyze → hypothesize → candidate → test/replay → accept/reject → persist.
 */
import crypto from 'node:crypto';
import { analyzeTrades, type AnalyzedTrade } from './analyze.js';
import { buildHypothesis } from './hypothesize.js';
import {
  applyPatches,
  createCandidateSession,
  ensureGenomeFile,
  promoteAcceptedVersion,
  restoreSnapshot,
} from './candidate.js';
import { evaluateCandidate, measureBaseline } from './evaluate.js';
import {
  loadExperience,
  recordCycle,
  saveExperience,
  updateSoftStreak,
  wasAlreadyTried,
  type BrainCycleRecord,
} from './experience.js';
import { getBrainGenome, reloadBrainGenome, setBrainGenome } from './brainGenome.js';
import { brainDecision, brainLog, brainSection } from './consoleUi.js';

export type CycleResult = BrainCycleRecord;

export async function runBrainCycle(opts?: {
  trades?: AnalyzedTrade[] | null;
  once?: boolean;
}): Promise<CycleResult> {
  const cycleId = `cycle_${Date.now().toString(36)}_${crypto.randomBytes(2).toString('hex')}`;
  let exp = loadExperience();
  ensureGenomeFile();
  const genome = getBrainGenome();

  brainSection('1) TRADES → ANALĪZE');
  const analysis = analyzeTrades(opts?.trades, exp);
  exp = loadExperience();
  for (const p of analysis.patterns) {
    const existing = exp.patterns.find((x) => x.id === p.id);
    if (!existing) exp.patterns.push(p);
    else {
      // Window counts are source of truth — do not keep inflated lifetime +=
      existing.count = p.count;
      existing.evidence = p.evidence;
      existing.last_seen = p.last_seen;
      existing.label = p.label;
    }
  }
  // Drop stale soft_loss inflation if window no longer shows undirected Soft
  if (!analysis.patterns.some((p) => p.id === 'soft_loss')) {
    exp.patterns = exp.patterns.filter((p) => p.id !== 'soft_loss' || p.count <= 0);
  }
  brainLog(analysis.summary);
  if (analysis.top_pattern) {
    brainLog(
      `Top pattern: ${analysis.top_pattern.id} ×${analysis.top_pattern.count} — ${analysis.top_pattern.label}`
    );
  }

  for (const t of analysis.trades.slice(-8)) {
    const soft =
      t.pnl_pts < 0 && /HardInvalidation|HardInv/i.test(String(t.exit_reason || ''));
    const side = t.direction === 'BUY' || t.direction === 'SELL' ? t.direction : null;
    exp = updateSoftStreak(
      exp,
      side,
      soft,
      genome.soft_same_side_pause_min,
      genome.soft_same_side_pause_closes
    );
  }
  if (exp.soft_pause_side) {
    brainLog(
      `SELF-MEMORY: pauzēju ${exp.soft_pause_side} vēl ${exp.soft_pause_left} close (Soft ķēde)`
    );
  }
  saveExperience(exp);

  brainSection('2) HIPOTĒZE → UZDEVUMS');
  let hypo = buildHypothesis(analysis, exp);
  if (!hypo) {
    const skip: CycleResult = {
      id: cycleId,
      at: new Date().toISOString(),
      pattern_id: analysis.top_pattern?.id || 'none',
      hypothesis_id: 'none',
      signature: 'none',
      decision: 'SKIPPED',
      reason: analysis.top_pattern
        ? 'Visas šī patterna hipotēzes jau izmēģinātas — gaidu jaunus trade / jaunu pattern'
        : 'Nav pietiekama pattern — gaidu vairāk close',
      baseline_expectancy: 0,
      candidate_expectancy: 0,
      tests_ok: true,
      changes_summary: [],
    };
    brainLog(skip.reason);
    brainDecision('SKIPPED', skip.reason);
    exp = recordCycle(exp, skip);
    saveExperience(exp);
    return skip;
  }
  brainLog(`Hipotēze: ${hypo.title}`);
  brainLog(`Kāpēc: ${hypo.rationale}`);
  brainLog(`Uzdevums: ${hypo.task}`);
  brainLog(`Signature: ${hypo.signature}`);

  // buildHypothesis already skips tried signatures — if collision slipped through,
  // mark it and force a fresh explore instead of idle SKIPPED spinning.
  if (wasAlreadyTried(exp, hypo.signature)) {
    brainLog(`Signature jau pieredzē — ģenerēju jaunu Force explore (bez SKIPPED idle)`);
    if (!exp.rejected_signatures.includes(hypo.signature)) {
      exp.rejected_signatures.push(hypo.signature);
    }
    saveExperience(exp);
    const retry = buildHypothesis(analysis, exp);
    if (!retry || wasAlreadyTried(exp, retry.signature)) {
      // Bump explore_step on disk so next cycle cannot repeat the same force
      const gNow = getBrainGenome();
      setBrainGenome({
        explore_step: (gNow.explore_step || 0) + 1,
        last_lesson: 'unstick signature collision',
      });
      reloadBrainGenome();
      const skip: CycleResult = {
        id: cycleId,
        at: new Date().toISOString(),
        pattern_id: hypo.pattern_id,
        hypothesis_id: hypo.id,
        signature: hypo.signature,
        decision: 'REJECTED',
        reason: 'Signature collision — bumped explore_step, retry next cycle',
        baseline_expectancy: 0,
        candidate_expectancy: 0,
        tests_ok: true,
        changes_summary: ['explore_step bump'],
      };
      brainDecision('REJECTED', skip.reason);
      exp = recordCycle(exp, skip);
      saveExperience(exp);
      return skip;
    }
    hypo = retry;
    brainLog(`Hipotēze (retry): ${hypo.title}`);
    brainLog(`Signature: ${hypo.signature}`);
  }

  brainSection('3) BASELINE REPLAY');
  const baseline = measureBaseline();
  brainLog(
    `Baseline E=${baseline.expectancy_pts.toFixed(3)} trades=${baseline.trades} WR=${(baseline.win_rate * 100).toFixed(0)}% SoftShare=${(baseline.soft_loss_share * 100).toFixed(0)}% EntryWait=${(baseline.entry_wait_score * 100).toFixed(0)}%`
  );

  brainSection('4) CANDIDATE PATCH');
  const session = createCandidateSession(cycleId);
  let applied: string[] = [];
  try {
    if (hypo.patches.length) {
      applied = applyPatches(hypo.patches);
      for (const a of applied) brainLog(`PATCH · ${a}`);
    }
    if (hypo.genome_delta && Object.keys(hypo.genome_delta).length) {
      setBrainGenome(hypo.genome_delta);
      reloadBrainGenome();
      brainLog(`GENOME · ${JSON.stringify(hypo.genome_delta)}`);
      if (!applied.length) {
        applied = Object.keys(hypo.genome_delta).map((k) => `genome.${k}`);
      }
    }
    if (!applied.length) {
      throw new Error('no-op candidate — nothing to apply');
    }
  } catch (err) {
    restoreSnapshot(session);
    reloadBrainGenome();
    const fail: CycleResult = {
      id: cycleId,
      at: new Date().toISOString(),
      pattern_id: hypo.pattern_id,
      hypothesis_id: hypo.id,
      signature: hypo.signature,
      decision: 'REJECTED',
      reason: `Patch/guard fail: ${err instanceof Error ? err.message : String(err)}`,
      baseline_expectancy: baseline.expectancy_pts,
      candidate_expectancy: baseline.expectancy_pts,
      tests_ok: false,
      changes_summary: applied,
    };
    brainDecision('REJECTED', fail.reason);
    exp = recordCycle(exp, fail);
    saveExperience(exp);
    return fail;
  }

  brainSection('5) TESTI + REPLAY');
  const report = evaluateCandidate(baseline);
  brainLog(report.test_detail.split('\n').slice(0, 8).join(' | '));
  brainLog(report.reason);

  const memoryKeys = new Set([
    'soft_same_side_pause_closes',
    'soft_same_side_pause_min',
    'require_1m_trigger',
    'wait_on_1m_fight',
    'mind_bank_on_turn',
    'last_lesson',
  ]);
  const deltaKeys = Object.keys(hypo.genome_delta || {}).filter((k) => k !== 'last_lesson');
  const defensiveMemory =
    report.tests_ok &&
    report.candidate.trades >= Math.max(0, report.baseline.trades - 3) &&
    report.candidate.expectancy_pts >= report.baseline.expectancy_pts - 0.01 &&
    deltaKeys.length > 0 &&
    deltaKeys.every((k) => memoryKeys.has(k));

  const accept = (report.improved && report.tests_ok) || defensiveMemory;
  if (defensiveMemory && !report.improved) {
    brainLog('Defensive memory knobs — tests OK, E not worse → ACCEPT');
  }

  if (!accept) {
    brainSection('6) REJECT → ROLLBACK');
    restoreSnapshot(session);
    reloadBrainGenome();
    const rej: CycleResult = {
      id: cycleId,
      at: new Date().toISOString(),
      pattern_id: hypo.pattern_id,
      hypothesis_id: hypo.id,
      signature: hypo.signature,
      decision: 'REJECTED',
      reason: report.reason,
      baseline_expectancy: report.baseline.expectancy_pts,
      candidate_expectancy: report.candidate.expectancy_pts,
      tests_ok: report.tests_ok,
      changes_summary: applied,
    };
    brainDecision('REJECTED', 'atjaunoju snapshot — pieredze saglabā signature');
    exp = recordCycle(exp, rej);
    saveExperience(exp);
    return rej;
  }

  brainSection('6) ACCEPT → JAUNĀ BRAIN VERSIJA');
  const versionDir = promoteAcceptedVersion(cycleId, session);
  brainLog(`Version saved: ${versionDir}`);
  const acc: CycleResult = {
    id: cycleId,
    at: new Date().toISOString(),
    pattern_id: hypo.pattern_id,
    hypothesis_id: hypo.id,
    signature: hypo.signature,
    decision: 'ACCEPTED',
    reason: defensiveMemory && !report.improved
      ? `ACCEPTED — defensive Soft-memory genome (E flat, tests OK)`
      : report.reason,
    baseline_expectancy: report.baseline.expectancy_pts,
    candidate_expectancy: report.candidate.expectancy_pts,
    tests_ok: true,
    changes_summary: applied,
  };
  exp = recordCycle(exp, acc);
  exp.last_lesson = hypo.title;
  saveExperience(exp);
  brainDecision('ACCEPTED', 'pieredze saglabāta — jaunā trading brain versija');
  return acc;
}
