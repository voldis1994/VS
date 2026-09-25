/**
 * Hard permission boundary for the autonomous brain self-improve agent.
 *
 * Policy (user intent):
 * - MAY rewrite any trading decision logic: entry/exit/manage/regimes/names/rules/
 *   features/weights/thresholds/SL-TP/trailing/calibration/learners/mind/etc.
 * - MUST NOT change lot/position size, broker/execution, security/auth/credentials,
 *   DB/routes plumbing, or this permission/guard mechanism itself.
 *
 * Model: deny-list for non-trading core + allow trading trees (not a tiny allowlist).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../../');
}

/** Explicit non-trading / dangerous path fragments — always blocked. */
export const BRAIN_FORBIDDEN_PATH_FRAGMENTS = [
  'lot_size',
  'lotSize',
  'capitalCom',
  'encryption',
  'security/',
  '/auth',
  'credentials',
  'db/pool',
  'db/migrate',
  'routes/',
  'clientPanel',
  'intentFanout',
  'pipelineBridge',
  'VS.bat',
  'BRAIN.bat',
  'brainSelfImprove/guards',
  'brainSelfImprove/cli',
  'node_modules',
  '.env',
  'package-lock',
  'package.json',
  'apps/dashboard',
  'apps/execution',
  'tools/',
] as const;

/** Content that must never appear in a candidate patch. */
export const BRAIN_FORBIDDEN_CONTENT = [
  /\blot_size\b\s*[:=]/,
  /\blotSize\b\s*[:=]/,
  /\bMASTER_ENCRYPTION_KEY\b/,
  /\bAPI_ADMIN_TOKEN\b/,
  /\bPIPELINE_TOKEN\b/,
  /\bpassword\b\s*[:=]/i,
  /\bapi_key\b\s*[:=]/i,
  /\bcreateCapitalPosition\b/,
  /\bcloseCapitalPosition\b/,
  /\bupdateCapitalPosition\b/,
  /\bdealReference\b/,
  /\bepics?Size\b/i,
] as const;

/** Prefixes where trading decision code / data lives (allowed if not forbidden). */
export const BRAIN_TRADING_PATH_PREFIXES = [
  'apps/control-api/src/services/',
  'apps/control-api/src/brainSelfImprove/',
  'data/brain-self-improve/',
  'data/desk-learner/',
  'data/desk-entry-learner/',
  'data/desk-learner-session.json',
] as const;

/** Service files that are system/broker plumbing, not trading decision logic. */
const BRAIN_FORBIDDEN_SERVICE_FILES = new Set([
  'capitalCom.ts',
  'capitalOhlcMid.ts',
  'clientPanel.ts',
  'clientPanelStatic.ts',
  'clientEvents.ts',
  'clientSubscriptions.ts',
  'intentFanout.ts',
  'pipelineBridge.ts',
  'audit.ts',
  'deskClientScope.ts',
]);

export type BrainPatch = {
  /** Repo-relative path */
  path: string;
  /** Exact old text (unique) */
  find: string;
  /** Replacement text */
  replace: string;
  note: string;
};

export function normalizeRepoPath(p: string): string {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .trim();
}

function isTradingTree(p: string): boolean {
  return (BRAIN_TRADING_PATH_PREFIXES as readonly string[]).some(
    (pref) => p === pref.replace(/\/$/, '') || p.startsWith(pref)
  );
}

export function isPathAllowed(relPath: string): { ok: true } | { ok: false; reason: string } {
  const p = normalizeRepoPath(relPath);
  if (!p) return { ok: false, reason: 'empty path' };

  const lower = p.toLowerCase();
  for (const frag of BRAIN_FORBIDDEN_PATH_FRAGMENTS) {
    if (lower.includes(frag.toLowerCase())) {
      return { ok: false, reason: `forbidden path fragment: ${frag}` };
    }
  }

  // Never patch tests / lockfiles / dist as "brain evolution"
  if (/\.test\.ts$/i.test(p) || /\.spec\.ts$/i.test(p) || /\/dist\//i.test(p)) {
    return { ok: false, reason: 'tests/dist not patchable by brain' };
  }

  if (p.startsWith('apps/control-api/src/services/')) {
    const base = path.posix.basename(p);
    if (BRAIN_FORBIDDEN_SERVICE_FILES.has(base)) {
      return { ok: false, reason: `non-trading service blocked: ${base}` };
    }
    if (base.endsWith('.ts')) return { ok: true };
  }

  if (p.startsWith('apps/control-api/src/brainSelfImprove/')) {
    const base = path.posix.basename(p);
    if (base === 'guards.ts' || base === 'cli.ts') {
      return { ok: false, reason: 'brain permission/cli protected' };
    }
    if (base.endsWith('.ts') || base.endsWith('.json')) return { ok: true };
  }

  if (p.startsWith('data/brain-self-improve/') || p.startsWith('data/desk-learner')) {
    return { ok: true };
  }

  if (isTradingTree(p)) return { ok: true };

  return { ok: false, reason: `not a trading decision path: ${p}` };
}

/**
 * Enumerate every currently allowed trading file for candidate snapshots.
 * Prefer this over a static allowlist so new regime/entry files are covered automatically.
 */
export function listAllowedTradingRelPaths(): string[] {
  const root = repoRoot();
  const out: string[] = [];

  const servicesDir = path.join(root, 'apps/control-api/src/services');
  if (fs.existsSync(servicesDir)) {
    for (const name of fs.readdirSync(servicesDir)) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
      const rel = `apps/control-api/src/services/${name}`;
      if (isPathAllowed(rel).ok) out.push(rel);
    }
  }

  const brainDir = path.join(root, 'apps/control-api/src/brainSelfImprove');
  if (fs.existsSync(brainDir)) {
    for (const name of fs.readdirSync(brainDir)) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
      const rel = `apps/control-api/src/brainSelfImprove/${name}`;
      if (isPathAllowed(rel).ok) out.push(rel);
    }
  }

  const genomeRel = 'data/brain-self-improve/genome.json';
  if (isPathAllowed(genomeRel).ok) out.push(genomeRel);

  return out;
}

/** @deprecated — use listAllowedTradingRelPaths(); kept for older imports. */
export const BRAIN_ALLOWED_REL_PATHS: readonly string[] = [];

export function isPatchContentAllowed(
  find: string,
  replace: string
): { ok: true } | { ok: false; reason: string } {
  const blob = `${find}\n${replace}`;
  for (const re of BRAIN_FORBIDDEN_CONTENT) {
    if (re.test(blob)) {
      return { ok: false, reason: `forbidden content matches ${re}` };
    }
  }
  // Lot / position size mutations
  if (/\b(lot_size|lotSize|quantity)\b/.test(replace) && /[:=]\s*\d/.test(replace)) {
    return { ok: false, reason: 'lot/position size mutation blocked' };
  }
  return { ok: true };
}

export function assertPatchesAllowed(patches: BrainPatch[]): void {
  for (const patch of patches) {
    const pathOk = isPathAllowed(patch.path);
    if (!pathOk.ok) throw new Error(`GUARD: ${pathOk.reason}`);
    const contentOk = isPatchContentAllowed(patch.find, patch.replace);
    if (!contentOk.ok) throw new Error(`GUARD: ${contentOk.reason} @ ${patch.path}`);
    if (!patch.find || patch.find === patch.replace) {
      throw new Error(`GUARD: empty or no-op patch @ ${patch.path}`);
    }
  }
}
