/**
 * Hard permission boundary for the autonomous brain self-improve agent.
 * Trading decision logic may mutate; system/broker/security/lot may not.
 */

export const BRAIN_ALLOWED_REL_PATHS = [
  'apps/control-api/src/services/exitManage.ts',
  'apps/control-api/src/services/traderMind.ts',
  'apps/control-api/src/services/manageBrain.ts',
  'apps/control-api/src/services/multiTfRead.ts',
  'apps/control-api/src/services/structureEntry.ts',
  'apps/control-api/src/services/deskLearner.ts',
  'apps/control-api/src/services/entryLearner.ts',
  'apps/control-api/src/services/regimes.ts',
  'apps/control-api/src/services/regimeExitProfile.ts',
  'apps/control-api/src/services/softExitMarketGate.ts',
  'apps/control-api/src/services/deskCalibration.ts',
  'apps/control-api/src/brainSelfImprove/brainGenome.ts',
  'data/brain-self-improve/genome.json',
] as const;

/** Path substrings that are always forbidden (even if somehow listed). */
export const BRAIN_FORBIDDEN_PATH_FRAGMENTS = [
  'lot_size',
  'capitalCom',
  'encryption',
  'security/',
  'auth',
  'credentials',
  'intentFanout',
  'flipFilter',
  'tradeOpenPolicy',
  'clientPanel',
  'db/pool',
  'db/migrate',
  'routes/',
  'VS.bat',
  'BRAIN.bat',
  'brainSelfImprove/guards',
  'brainSelfImprove/cli',
  'node_modules',
  '.env',
  'package-lock',
] as const;

/** Content patterns that must never appear in a candidate patch. */
export const BRAIN_FORBIDDEN_CONTENT = [
  /\blot_size\b\s*[:=]/,
  /\bMASTER_ENCRYPTION_KEY\b/,
  /\bAPI_ADMIN_TOKEN\b/,
  /\bPIPELINE_TOKEN\b/,
  /\bpassword\b\s*[:=]/i,
  /\bapi_key\b\s*[:=]/i,
  /\bcreateCapitalPosition\b/,
  /\bcloseCapitalPosition\b/,
  /\bupdateCapitalPosition\b/,
  /\bentryFlipLockEnabled\b/,
  /\bsameDirectionBlocked\b/,
] as const;

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

export function isPathAllowed(relPath: string): { ok: true } | { ok: false; reason: string } {
  const p = normalizeRepoPath(relPath);
  if (!p) return { ok: false, reason: 'empty path' };
  for (const frag of BRAIN_FORBIDDEN_PATH_FRAGMENTS) {
    if (p.toLowerCase().includes(frag.toLowerCase())) {
      return { ok: false, reason: `forbidden path fragment: ${frag}` };
    }
  }
  if (!(BRAIN_ALLOWED_REL_PATHS as readonly string[]).includes(p)) {
    return { ok: false, reason: `path not on allowlist: ${p}` };
  }
  return { ok: true };
}

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
  // Lot / size mutations
  if (/\b(lot|quantity|size)\b/i.test(replace) && /[:=]\s*\d/.test(replace)) {
    if (/\blot_size\b|\blotSize\b|\bquantity\b/.test(replace)) {
      return { ok: false, reason: 'lot/position size mutation blocked' };
    }
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
