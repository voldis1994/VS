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
import {
  getBrainGenome,
  reloadBrainGenome,
  setBrainGenome,
  TRADING_INTEL_GENOME_KEYS,
} from './brainGenome.js';
import { requestBrainCodeReload } from './brainReload.js';
import { brainDecision, brainLog, brainSection } from './consoleUi.js';

export type CycleResult = BrainCycleRecord;

/**
 * Soft pause closes/min are live-desk memory only — strategy replay + EntryWait
 * never see them. Accepting E-flat pause bounce (11↔12) was infinite SI thrash.
 */
export function isPauseOnlyGenomeThrash(deltaKeys: string[]): boolean {
  const ignorable = new Set(['explore_step', 'version']);
  const meaningful = deltaKeys.filter((k) => !ignorable.has(k));
  if (!meaningful.length) return false;
  return meaningful.every(
    (k) => k === 'soft_same_side_pause_closes' || k === 'soft_same_side_pause_min'
  );
}

/** Soft pct alone also does not move EntryWait — E-flat ACCEPT to 0.1bp was Soft suicide. */
export function isSoftPctOnlyGenomeThrash(deltaKeys: string[]): boolean {
  const ignorable = new Set(['explore_step', 'version']);
  const meaningful = deltaKeys.filter((k) => !ignorable.has(k));
  return meaningful.length > 0 && meaningful.every((k) => k === 'hardinv_pct_bp');
}

/**
 * Soft spam top + hardinv_pct_bp (even with pause/require sneak) = thrash.
 * Live: CIKLS #14–17 ACCEPTed Soft pct 5.1→4bp while EntryWait 100%.
 */
export function isSoftPctThrashWhileSoftSpam(
  softFocusTop: boolean,
  deltaKeys: string[],
  title: string
): boolean {
  if (!softFocusTop) return false;
  if (/Soft pct/i.test(title)) return true;
  return deltaKeys.includes('hardinv_pct_bp');
}

/** explore_step-only bump while Soft spam top — infinite empty ACCEPT. */
export function isExploreStepOnlyThrash(deltaKeys: string[]): boolean {
  return (
    deltaKeys.length > 0 &&
    deltaKeys.every((k) => k === 'explore_step' || k === 'version')
  );
}

/** Soft spam top + Peak Keep / scratch = wrong lever (was ACCEPT via require_1m sneak). */
export function isKeepThrashWhileSoftSpam(
  softFocusTop: boolean,
  deltaKeys: string[],
  title: string
): boolean {
  if (!softFocusTop) return false;
  return (
    deltaKeys.includes('peak_keep') ||
    deltaKeys.includes('soft_plus_giveback') ||
    deltaKeys.includes('peak_arm_soft_mult') ||
    /Keep|scratch/i.test(title)
  );
}

/** Shields already ON + "reinforce" / shield-only delta = infinite explore_step ACCEPT. */
export function isNoopShieldThrash(
  shieldsAlreadyOn: boolean,
  deltaKeys: string[],
  title: string
): boolean {
  if (!shieldsAlreadyOn) return false;
  if (/reinforce 1m Soft shields/i.test(title)) return true;
  const ignorable = new Set(['explore_step', 'version']);
  const meaningful = deltaKeys.filter((k) => !ignorable.has(k));
  return (
    meaningful.length > 0 &&
    meaningful.every((k) => k === 'wait_on_1m_fight' || k === 'require_1m_trigger')
  );
}

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
  const evolveKeys = new Set<string>([
    ...memoryKeys,
    'peak_keep',
    'soft_plus_giveback',
    'peak_arm_soft_mult',
    'explore_step',
    'version',
    ...TRADING_INTEL_GENOME_KEYS,
  ]);
  const deltaKeys = Object.keys(hypo.genome_delta || {}).filter((k) => k !== 'last_lesson');
  const eFlatOk =
    report.candidate.expectancy_pts >= report.baseline.expectancy_pts - 0.01 &&
    report.candidate.trades >= Math.max(0, report.baseline.trades - 3);
  // Soft spam still top → only REAL E gain ACCEPT (no E-flat / SoftShare twitch)
  const softFocusTop =
    analysis.top_pattern?.id === 'soft_sell_spam' ||
    analysis.top_pattern?.id === 'soft_buy_spam' ||
    analysis.top_pattern?.id === 'soft_loss' ||
    analysis.soft_sell_losses >= 2 ||
    analysis.soft_buy_losses >= 2 ||
    analysis.soft_losses >= 2;
  const hypoTitle = String(hypo.title || '');
  const pauseOnlyThrash = isPauseOnlyGenomeThrash(deltaKeys);
  const softPctOnlyThrash = isSoftPctOnlyGenomeThrash(deltaKeys);
  const softPctThrashWhileSoft = isSoftPctThrashWhileSoftSpam(
    softFocusTop,
    deltaKeys,
    hypoTitle
  );
  // All Soft-pause titles (not only Explore Soft pause)
  const titlePauseThrash =
    /Explore Soft pause|Pause SELL|Pause BUY|Harder Soft|Harder BUY Soft|Cut Soft HardInv|Force Soft/i.test(
      hypoTitle
    );
  const exploreStepOnly = isExploreStepOnlyThrash(deltaKeys);
  const shieldsAlreadyOn = Boolean(genome.wait_on_1m_fight && genome.require_1m_trigger);
  const noopShieldThrash = isNoopShieldThrash(shieldsAlreadyOn, deltaKeys, hypoTitle);
  // Soft spam + pause knobs (even with require sneak) = thrash — replay never sees pause
  const pauseCargoWhileSoft =
    softFocusTop &&
    (deltaKeys.includes('soft_same_side_pause_closes') ||
      deltaKeys.includes('soft_same_side_pause_min') ||
      titlePauseThrash);
  const genomeThrash =
    pauseOnlyThrash ||
    softPctOnlyThrash ||
    softPctThrashWhileSoft ||
    titlePauseThrash ||
    exploreStepOnly ||
    noopShieldThrash ||
    pauseCargoWhileSoft;
  const defensiveMemory =
    !softFocusTop &&
    report.tests_ok &&
    eFlatOk &&
    deltaKeys.length > 0 &&
    deltaKeys.every((k) => memoryKeys.has(k)) &&
    !genomeThrash;
  // Only treat shield knobs as Soft evolve when they actually turn ON (not already true)
  const softKnobDelta =
    (!genome.require_1m_trigger && deltaKeys.includes('require_1m_trigger')) ||
    (!genome.wait_on_1m_fight && deltaKeys.includes('wait_on_1m_fight'));
  const onlyShieldFlip =
    softKnobDelta &&
    deltaKeys.every(
      (k) =>
        k === 'require_1m_trigger' ||
        k === 'wait_on_1m_fight' ||
        k === 'explore_step' ||
        k === 'version'
    );
  const keepThrashWhileSoft = isKeepThrashWhileSoftSpam(
    softFocusTop,
    deltaKeys,
    hypoTitle
  );
  // Non-Soft: E-flat safe evolve OK. Soft spam: NEVER E-flat safe/defensive.
  const safeGenomeEvolve =
    !softFocusTop &&
    report.tests_ok &&
    eFlatOk &&
    deltaKeys.length > 0 &&
    deltaKeys.every((k) => evolveKeys.has(k)) &&
    !genomeThrash &&
    !keepThrashWhileSoft &&
    (hypo.pattern_id === 'explore' ||
      softKnobDelta ||
      deltaKeys.some(
        (k) =>
          TRADING_INTEL_GENOME_KEYS.includes(k as (typeof TRADING_INTEL_GENOME_KEYS)[number])
      ));

  const eGain =
    report.candidate.expectancy_pts - report.baseline.expectancy_pts;
  // Soft spam: SoftShare/WR twitch with E flat must NOT ACCEPT (was thrash via report.improved)
  const realImprove =
    report.improved && report.tests_ok && (!softFocusTop || eGain > 0.02);
  // Soft spam: only first-time shield ON (no pause/pct/Keep cargo)
  const softShieldOn =
    softFocusTop &&
    onlyShieldFlip &&
    report.tests_ok &&
    eFlatOk &&
    !genomeThrash &&
    !keepThrashWhileSoft;

  const accept = realImprove || defensiveMemory || safeGenomeEvolve || softShieldOn;
  if ((defensiveMemory || safeGenomeEvolve || softShieldOn) && !realImprove && accept) {
    brainLog(
      softShieldOn
        ? 'Soft shields ON first time — tests OK, E not worse → ACCEPT'
        : safeGenomeEvolve
          ? 'Safe genome evolve — tests OK, E not worse → ACCEPT'
          : 'Defensive memory knobs — tests OK, E not worse → ACCEPT'
    );
  }
  if (softFocusTop && report.improved && !realImprove && !accept) {
    brainLog(
      'Soft spam top — E-flat SoftShare/WR twitch blocked (need real E gain); REJECT'
    );
  }
  if (keepThrashWhileSoft && !realImprove) {
    brainLog('Soft spam top — Peak Keep / scratch blocked from E-flat ACCEPT');
  }
  if (genomeThrash && !realImprove) {
    brainLog(
      pauseCargoWhileSoft || titlePauseThrash
        ? 'Soft pause thrash blocked while Soft spam top — pause invisible to replay; REJECT'
        : softPctThrashWhileSoft
          ? 'Soft pct thrash blocked while Soft spam top — hardinv does not cut entry spam; REJECT'
          : noopShieldThrash
            ? 'No-op Soft shield reinforce blocked — already ON; REJECT'
            : exploreStepOnly
              ? 'explore_step-only thrash blocked — no real Soft lever; REJECT'
              : pauseOnlyThrash
                ? 'Soft pause thrash blocked — pause knobs do not move replay E; REJECT'
                : 'Soft pct-only thrash blocked — hardinv alone does not move EntryWait; REJECT'
    );
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
  // Keep ACCEPTed .ts patches — operator wants brain to rewrite trading code.
  // Soft reload still waits until all robots are FLAT (brainReload).
  const keptCodeFiles = [
    ...new Set(
      hypo.patches
        .map((p) => p.path.replace(/\\/g, '/'))
        .filter((p) => p.endsWith('.ts') && !p.includes('genome.json'))
    ),
  ];
  const versionDir = promoteAcceptedVersion(cycleId, session);
  brainLog(`Version saved: ${versionDir}`);
  if (keptCodeFiles.length) {
    requestBrainCodeReload({
      cycle_id: cycleId,
      reason: hypo.title,
      files: [...new Set(keptCodeFiles)],
    });
    brainLog(
      `Code patches KEPT — API soft-reload when all robots FLAT (${keptCodeFiles.length} file(s))`
    );
  }
  const acc: CycleResult = {
    id: cycleId,
    at: new Date().toISOString(),
    pattern_id: hypo.pattern_id,
    hypothesis_id: hypo.id,
    signature: hypo.signature,
    decision: 'ACCEPTED',
    reason:
      (defensiveMemory || safeGenomeEvolve) && !report.improved
        ? safeGenomeEvolve
          ? `ACCEPTED — safe genome evolve (E flat, tests OK)`
          : `ACCEPTED — defensive Soft-memory genome (E flat, tests OK)`
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
