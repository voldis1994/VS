/**
 * Persistent experience store — survives restart; skips already-rejected signatures.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { BrainPatch } from './guards.js';

export type BrainErrorPattern = {
  id: string;
  label: string;
  count: number;
  evidence: string[];
  first_seen: string;
  last_seen: string;
};

export type BrainHypothesis = {
  id: string;
  pattern_id: string;
  title: string;
  rationale: string;
  task: string;
  patches: BrainPatch[];
  genome_delta?: Record<string, unknown>;
  signature: string;
  created_at: string;
};

export type BrainCycleRecord = {
  id: string;
  at: string;
  pattern_id: string;
  hypothesis_id: string;
  signature: string;
  decision: 'ACCEPTED' | 'REJECTED' | 'SKIPPED';
  reason: string;
  baseline_expectancy: number;
  candidate_expectancy: number;
  tests_ok: boolean;
  changes_summary: string[];
};

export type BrainExperience = {
  version: number;
  updated_at: string;
  cycles: BrainCycleRecord[];
  patterns: BrainErrorPattern[];
  /** Signatures already tried and rejected — never repeat */
  rejected_signatures: string[];
  /** Signatures accepted */
  accepted_signatures: string[];
  /** Soft same-side pause memory */
  soft_pause_side: 'BUY' | 'SELL' | null;
  soft_pause_left: number;
  soft_sell_streak: number;
  soft_buy_streak: number;
  last_lesson: string;
};

function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../../');
}

export function experiencePath(): string {
  const env = process.env.BRAIN_EXPERIENCE_PATH?.trim();
  if (env) return env;
  return path.join(repoRoot(), 'data', 'brain-self-improve', 'experience.json');
}

function emptyExperience(): BrainExperience {
  return {
    version: 1,
    updated_at: new Date().toISOString(),
    cycles: [],
    patterns: [],
    rejected_signatures: [],
    accepted_signatures: [],
    soft_pause_side: null,
    soft_pause_left: 0,
    soft_sell_streak: 0,
    soft_buy_streak: 0,
    last_lesson: '',
  };
}

export function loadExperience(): BrainExperience {
  const p = experiencePath();
  try {
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as BrainExperience;
      return {
        ...emptyExperience(),
        ...raw,
        cycles: Array.isArray(raw.cycles) ? raw.cycles : [],
        patterns: Array.isArray(raw.patterns) ? raw.patterns : [],
        rejected_signatures: Array.isArray(raw.rejected_signatures)
          ? raw.rejected_signatures
          : [],
        accepted_signatures: Array.isArray(raw.accepted_signatures)
          ? raw.accepted_signatures
          : [],
      };
    }
  } catch {
    /* fresh */
  }
  return emptyExperience();
}

export function saveExperience(exp: BrainExperience): void {
  const p = experiencePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const next = { ...exp, updated_at: new Date().toISOString() };
  fs.writeFileSync(p, JSON.stringify(next, null, 2) + '\n', 'utf8');
}

export function hypothesisSignature(h: {
  pattern_id: string;
  patches: BrainPatch[];
  genome_delta?: Record<string, unknown>;
}): string {
  const payload = JSON.stringify({
    pattern_id: h.pattern_id,
    patches: h.patches.map((x) => ({ path: x.path, find: x.find, replace: x.replace })),
    genome_delta: h.genome_delta || {},
  });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 24);
}

export function wasAlreadyTried(exp: BrainExperience, signature: string): boolean {
  return (
    exp.rejected_signatures.includes(signature) ||
    exp.accepted_signatures.includes(signature)
  );
}

export function notePattern(
  exp: BrainExperience,
  id: string,
  label: string,
  evidence: string
): BrainExperience {
  const now = new Date().toISOString();
  const existing = exp.patterns.find((p) => p.id === id);
  if (existing) {
    existing.count += 1;
    existing.last_seen = now;
    existing.evidence = [...existing.evidence.slice(-8), evidence].slice(-10);
  } else {
    exp.patterns.push({
      id,
      label,
      count: 1,
      evidence: [evidence],
      first_seen: now,
      last_seen: now,
    });
  }
  return exp;
}

export function recordCycle(exp: BrainExperience, cycle: BrainCycleRecord): BrainExperience {
  exp.cycles.unshift(cycle);
  if (exp.cycles.length > 80) exp.cycles.length = 80;
  if (cycle.decision === 'REJECTED') {
    if (!exp.rejected_signatures.includes(cycle.signature)) {
      exp.rejected_signatures.push(cycle.signature);
    }
  }
  if (cycle.decision === 'ACCEPTED') {
    if (!exp.accepted_signatures.includes(cycle.signature)) {
      exp.accepted_signatures.push(cycle.signature);
    }
    exp.last_lesson = cycle.reason;
  }
  if (exp.rejected_signatures.length > 200) {
    exp.rejected_signatures = exp.rejected_signatures.slice(-200);
  }
  return exp;
}

export function updateSoftStreak(
  exp: BrainExperience,
  side: 'BUY' | 'SELL' | null,
  wasSoftLoss: boolean,
  pauseMin: number,
  pauseCloses: number
): BrainExperience {
  if (!wasSoftLoss || !side) {
    if (!wasSoftLoss && side) {
      // Win or non-Soft on a side clears that streak
      if (side === 'SELL') exp.soft_sell_streak = 0;
      if (side === 'BUY') exp.soft_buy_streak = 0;
      if (exp.soft_pause_side === side) {
        exp.soft_pause_side = null;
        exp.soft_pause_left = 0;
      }
    }
    return exp;
  }
  if (side === 'SELL') {
    exp.soft_sell_streak += 1;
    exp.soft_buy_streak = 0;
    if (exp.soft_sell_streak >= pauseMin) {
      exp.soft_pause_side = 'SELL';
      exp.soft_pause_left = pauseCloses;
    }
  } else {
    exp.soft_buy_streak += 1;
    exp.soft_sell_streak = 0;
    if (exp.soft_buy_streak >= pauseMin) {
      exp.soft_pause_side = 'BUY';
      exp.soft_pause_left = pauseCloses;
    }
  }
  return exp;
}

export function consumeSoftPauseOnEntryAttempt(exp: BrainExperience): BrainExperience {
  if (exp.soft_pause_left > 0) {
    exp.soft_pause_left -= 1;
    if (exp.soft_pause_left <= 0) {
      exp.soft_pause_side = null;
      exp.soft_pause_left = 0;
    }
  }
  return exp;
}

export function getSoftPauseSide(exp?: BrainExperience | null): 'BUY' | 'SELL' | null {
  const e = exp || loadExperience();
  if (e.soft_pause_left > 0 && (e.soft_pause_side === 'BUY' || e.soft_pause_side === 'SELL')) {
    return e.soft_pause_side;
  }
  return null;
}
