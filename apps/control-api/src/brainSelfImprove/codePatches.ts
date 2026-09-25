/**
 * Concrete trading-code patches the brain may apply (constants / thresholds).
 * Reads live source so find strings match the current file (post prior ACCEPTed edits).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrainPatch } from './guards.js';
import { isPathAllowed, isPatchContentAllowed } from './guards.js';

function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../../');
}

function readRel(rel: string): string | null {
  const abs = path.join(repoRoot(), rel);
  try {
    if (!fs.existsSync(abs)) return null;
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

function formatInt(n: number): string {
  const v = Math.round(n);
  if (Math.abs(v) >= 1000 && v % 1000 === 0) {
    return `${v < 0 ? '-' : ''}${Math.abs(v) / 1000}_000`;
  }
  return String(v);
}

function formatNum(n: number): string {
  if (Number.isInteger(n)) return formatInt(n);
  return String(n);
}

/**
 * Patch `const NAME = <number>` or `export const NAME = <number>` to nextVal.
 * Returns null if missing, no-op, or guard rejects.
 */
export function constNumPatch(
  relPath: string,
  constName: string,
  nextVal: number,
  note: string
): BrainPatch | null {
  if (!isPathAllowed(relPath).ok) return null;
  const src = readRel(relPath);
  if (!src) return null;
  const re = new RegExp(
    `((?:export\\s+)?const\\s+${constName}\\s*=\\s*)(-?[0-9][0-9_]*(?:\\.[0-9]+)?)`
  );
  const m = src.match(re);
  if (!m || m.index == null) return null;
  const curRaw = m[2]!;
  const cur = Number(curRaw.replace(/_/g, ''));
  if (!Number.isFinite(cur) || cur === nextVal) return null;
  const find = m[0];
  const replace = `${m[1]}${formatNum(nextVal)}`;
  if (find === replace) return null;
  if (!isPatchContentAllowed(find, replace).ok) return null;
  // Uniqueness
  if (src.split(find).length !== 2) return null;
  return { path: relPath, find, replace, note };
}

/**
 * Patch a unique exact snippet (must appear once).
 */
export function snippetPatch(
  relPath: string,
  find: string,
  replace: string,
  note: string
): BrainPatch | null {
  if (!find || find === replace) return null;
  if (!isPathAllowed(relPath).ok) return null;
  if (!isPatchContentAllowed(find, replace).ok) return null;
  const src = readRel(relPath);
  if (!src || !src.includes(find)) return null;
  if (src.split(find).length !== 2) return null;
  return { path: relPath, find, replace, note };
}

function readConst(relPath: string, constName: string): number | null {
  const src = readRel(relPath);
  if (!src) return null;
  const re = new RegExp(
    `(?:export\\s+)?const\\s+${constName}\\s*=\\s*(-?[0-9][0-9_]*(?:\\.[0-9]+)?)`
  );
  const m = src.match(re);
  if (!m) return null;
  const n = Number(m[1]!.replace(/_/g, ''));
  return Number.isFinite(n) ? n : null;
}

const FLIP = 'apps/control-api/src/services/flipFilter.ts';
const STRUCTURE = 'apps/control-api/src/services/structureEntry.ts';
const MIND = 'apps/control-api/src/services/traderMind.ts';

/** Soft spam / Soft loss — longer same-dir lock after Soft. */
export function codePatchesSoftSpam(step = 0): BrainPatch[] {
  const out: BrainPatch[] = [];
  const curLoss = readConst(FLIP, 'SAME_DIR_LOCK_AFTER_LOSS_MS') ?? 90_000;
  const nextLoss = Math.min(300_000, curLoss + 30_000 + step * 30_000);
  const p1 = constNumPatch(
    FLIP,
    'SAME_DIR_LOCK_AFTER_LOSS_MS',
    nextLoss,
    `Soft same-dir lock ${curLoss}→${nextLoss}ms`
  );
  if (p1) out.push(p1);

  const curWin = readConst(FLIP, 'SAME_DIR_LOCK_MS') ?? 90_000;
  const nextWin = Math.min(180_000, curWin + 15_000 + step * 15_000);
  const p2 = constNumPatch(
    FLIP,
    'SAME_DIR_LOCK_MS',
    nextWin,
    `Win same-dir lock ${curWin}→${nextWin}ms`
  );
  if (p2) out.push(p2);

  // Mind: earlier CUT when giving back Soft-sized green
  const p3 = snippetPatch(
    MIND,
    '} else if (mfe >= soft * 0.75 && upl > 0 && (againstUs || retention < 0.55)) {',
    '} else if (mfe >= soft * 0.75 && upl > 0 && (againstUs || retention < 0.62)) {',
    'Mind CUT earlier on Soft+ giveback (0.55→0.62)'
  );
  if (p3) out.push(p3);

  return out;
}

/** Micro scratch — stricter structure extremes / start bands. */
export function codePatchesMicroScratch(step = 0): BrainPatch[] {
  const out: BrainPatch[] = [];
  const hi = readConst(STRUCTURE, 'EXTREME_HI') ?? 0.85;
  const nextHi = Math.min(0.95, Number((hi + 0.02 + step * 0.01).toFixed(2)));
  const p1 = constNumPatch(STRUCTURE, 'EXTREME_HI', nextHi, `EXTREME_HI ${hi}→${nextHi}`);
  if (p1) out.push(p1);

  const lo = readConst(STRUCTURE, 'EXTREME_LO') ?? 0.15;
  const nextLo = Math.max(0.05, Number((lo - 0.02 - step * 0.01).toFixed(2)));
  const p2 = constNumPatch(STRUCTURE, 'EXTREME_LO', nextLo, `EXTREME_LO ${lo}→${nextLo}`);
  if (p2) out.push(p2);

  // Prefer closer-to-edge structure starts (less mid-zone noise)
  const startLo = readConst(STRUCTURE, 'START_LO') ?? 0.65;
  const nextStartLo = Math.min(0.8, Number((startLo + 0.03).toFixed(2)));
  const p3 = constNumPatch(
    STRUCTURE,
    'START_LO',
    nextStartLo,
    `START_LO ${startLo}→${nextStartLo}`
  );
  if (p3) out.push(p3);

  return out;
}

/** Green left on table — Mind banks Soft+ sooner (retention threshold). */
export function codePatchesBankGreen(): BrainPatch[] {
  const out: BrainPatch[] = [];
  const p1 = snippetPatch(
    MIND,
    '} else if (mfe >= soft * 0.75 && upl > 0 && (againstUs || retention < 0.55)) {',
    '} else if (mfe >= soft * 0.7 && upl > 0 && (againstUs || retention < 0.65)) {',
    'Mind CUT Soft+ earlier (0.75/0.55 → 0.7/0.65)'
  );
  if (p1) out.push(p1);

  const p2 = snippetPatch(
    MIND,
    'const greenSoft = upl >= soft * 0.95 && mfe >= soft;',
    'const greenSoft = upl >= soft * 0.9 && mfe >= soft * 0.95;',
    'MindBank Soft+ arms slightly earlier'
  );
  if (p2) out.push(p2);

  return out;
}

/** Explore: nudge multi-TF comment-free numeric if present — else flip lock tick. */
export function codePatchesExplore(step: number): BrainPatch[] {
  const out: BrainPatch[] = [];
  const cur = readConst(FLIP, 'SAME_DIR_LOCK_AFTER_LOSS_MS') ?? 90_000;
  // Bounce 60s..300s
  const dir = step % 2 === 0 ? 1 : -1;
  let next = cur + dir * 30_000;
  if (next > 300_000) next = cur - 30_000;
  if (next < 60_000) next = cur + 30_000;
  const p = constNumPatch(
    FLIP,
    'SAME_DIR_LOCK_AFTER_LOSS_MS',
    next,
    `Explore Soft lock ${cur}→${next}ms`
  );
  if (p) out.push(p);
  return out;
}
