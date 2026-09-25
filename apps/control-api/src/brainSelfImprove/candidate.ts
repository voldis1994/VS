/**
 * Candidate workspace — snapshot allowlisted files, apply patches, restore on reject.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertPatchesAllowed,
  listAllowedTradingRelPaths,
  normalizeRepoPath,
  type BrainPatch,
} from './guards.js';
import { defaultBrainGenome, genomePath, sanitizeGenome, type BrainGenome } from './brainGenome.js';

function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../../');
}

const GENOME_REL = 'data/brain-self-improve/genome.json';

export type CandidateSession = {
  id: string;
  snapshotDir: string;
  touched: string[];
  /** Absolute path that was snapshotted for the live genome (env override aware). */
  genomeAbs: string;
};

export function ensureGenomeFile(): void {
  const p = genomePath();
  if (!fs.existsSync(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const g = sanitizeGenome({ ...defaultBrainGenome(), updated_at: new Date().toISOString() });
    fs.writeFileSync(p, JSON.stringify(g, null, 2) + '\n', 'utf8');
  }
}

function resolvePatchAbs(rel: string): string {
  const n = normalizeRepoPath(rel);
  if (n === GENOME_REL || n.endsWith('/genome.json') || n === 'genome.json') {
    return genomePath();
  }
  return path.join(repoRoot(), n);
}

export function createCandidateSession(cycleId: string): CandidateSession {
  ensureGenomeFile();
  const snapshotDir = path.join(
    repoRoot(),
    'data',
    'brain-self-improve',
    'snapshots',
    cycleId
  );
  fs.mkdirSync(snapshotDir, { recursive: true });
  const touched: string[] = [];
  const genomeAbs = genomePath();

  for (const rel of listAllowedTradingRelPaths()) {
    const isGenome = rel === GENOME_REL;
    const abs = isGenome ? genomeAbs : path.join(repoRoot(), rel);
    if (!fs.existsSync(abs)) continue;
    const dest = path.join(snapshotDir, isGenome ? GENOME_REL : rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(abs, dest);
    touched.push(isGenome ? GENOME_REL : rel);
  }
  return { id: cycleId, snapshotDir, touched, genomeAbs };
}

export function applyPatches(patches: BrainPatch[]): string[] {
  assertPatchesAllowed(patches);
  ensureGenomeFile();
  const applied: string[] = [];
  for (const patch of patches) {
    const rel = normalizeRepoPath(patch.path);
    const abs = resolvePatchAbs(rel);
    if (!fs.existsSync(abs)) {
      throw new Error(`patch target missing: ${rel} → ${abs}`);
    }
    const before = fs.readFileSync(abs, 'utf8');
    if (!before.includes(patch.find)) {
      if (rel === GENOME_REL || abs === genomePath()) {
        const g = sanitizeGenome(JSON.parse(before) as Partial<BrainGenome>);
        const keyMatch = /"([a-z0-9_]+)":/.exec(patch.find);
        if (keyMatch) {
          const key = keyMatch[1] as keyof BrainGenome;
          const valRaw = patch.replace.split(':').slice(1).join(':').trim().replace(/,$/, '');
          let val: string | number | boolean = valRaw;
          if (valRaw === 'true') val = true;
          else if (valRaw === 'false') val = false;
          else if (/^".*"$/.test(valRaw)) val = JSON.parse(valRaw) as string;
          else if (Number.isFinite(Number(valRaw))) val = Number(valRaw);
          (g as Record<string, unknown>)[key] = val;
          fs.writeFileSync(abs, JSON.stringify(sanitizeGenome(g), null, 2) + '\n', 'utf8');
          applied.push(`${rel} · ${patch.note} (json-key)`);
          continue;
        }
      }
      throw new Error(`find text not found in ${rel}: ${patch.find.slice(0, 80)}`);
    }
    const parts = before.split(patch.find);
    if (parts.length !== 2) {
      throw new Error(`find text not unique in ${rel} (count=${parts.length - 1})`);
    }
    const after = parts.join(patch.replace);
    fs.writeFileSync(abs, after, 'utf8');
    applied.push(`${rel} · ${patch.note}`);
  }
  return applied;
}

export function restoreSnapshot(session: CandidateSession): void {
  for (const rel of session.touched) {
    const src = path.join(session.snapshotDir, rel);
    const dest =
      rel === GENOME_REL ? session.genomeAbs || genomePath() : path.join(repoRoot(), rel);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

/**
 * Keep genome ACCEPTed, roll back only listed .ts sources (or all .ts if omit).
 * Used when "safe genome evolve" rode along with filter code patches —
 * otherwise every Explore Keep would rewrite flipFilter and blink the desk.
 */
export function restoreCodeSourcesFromSnapshot(
  session: CandidateSession,
  onlyRels?: string[]
): string[] {
  const want =
    onlyRels && onlyRels.length
      ? new Set(onlyRels.map((r) => r.replace(/\\/g, '/')))
      : null;
  const restored: string[] = [];
  for (const rel of session.touched) {
    const norm = rel.replace(/\\/g, '/');
    if (!norm.endsWith('.ts')) continue;
    if (norm.includes('genome.json')) continue;
    if (want && !want.has(norm)) continue;
    const src = path.join(session.snapshotDir, rel);
    const dest = path.join(repoRoot(), rel);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    restored.push(norm);
  }
  return restored;
}

export function promoteAcceptedVersion(cycleId: string, session: CandidateSession): string {
  const versionDir = path.join(
    repoRoot(),
    'data',
    'brain-self-improve',
    'versions',
    cycleId
  );
  fs.mkdirSync(versionDir, { recursive: true });
  for (const rel of session.touched) {
    const abs =
      rel === GENOME_REL ? session.genomeAbs || genomePath() : path.join(repoRoot(), rel);
    if (!fs.existsSync(abs)) continue;
    const dest = path.join(versionDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(abs, dest);
  }
  const meta = {
    id: cycleId,
    at: new Date().toISOString(),
    files: session.touched,
  };
  fs.writeFileSync(path.join(versionDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  return versionDir;
}
