/**
 * Signed/versioned updater with staging, preflight, backup, atomic activate, rollback.
 */

import {
  createHash,
  createVerify,
} from 'crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';

export type ReleaseManifest = {
  version: string;
  sha256: string;
  /** Optional PEM public-key signature over `${version}:${sha256}`. */
  signature?: string;
  created_at: string;
};

export type UpdateResult =
  | { ok: true; version: string; rolled_back: false }
  | { ok: true; version: string; rolled_back: true; reason: string }
  | { ok: false; reason: string };

export type UpdaterDeps = {
  root: string;
  publicKeyPem?: string;
  /** Return false to defer update (e.g. open positions). */
  preflight: () => Promise<{ ok: boolean; reason?: string }>;
  healthCheck: () => Promise<{ ok: boolean; reason?: string }>;
  activate: (stagedDir: string) => Promise<void>;
  restoreBackup: (backupDir: string) => Promise<void>;
};

export function sha256Buffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function verifyManifest(
  manifest: ReleaseManifest,
  payload: Buffer,
  publicKeyPem?: string
): { ok: boolean; reason?: string } {
  const hash = sha256Buffer(payload);
  if (hash !== manifest.sha256.toLowerCase()) {
    return { ok: false, reason: 'SHA256 mismatch' };
  }
  if (manifest.signature && publicKeyPem) {
    const v = createVerify('SHA256');
    v.update(`${manifest.version}:${manifest.sha256}`);
    v.end();
    if (!v.verify(publicKeyPem, Buffer.from(manifest.signature, 'base64'))) {
      return { ok: false, reason: 'Signature verification failed' };
    }
  }
  return { ok: true };
}

export async function applyUpdate(
  manifest: ReleaseManifest,
  payload: Buffer,
  deps: UpdaterDeps
): Promise<UpdateResult> {
  const verify = verifyManifest(manifest, payload, deps.publicKeyPem);
  if (!verify.ok) return { ok: false, reason: verify.reason || 'verify failed' };

  const pre = await deps.preflight();
  if (!pre.ok) return { ok: false, reason: pre.reason || 'preflight deferred' };

  const staging = join(deps.root, 'staging', manifest.version);
  const backup = join(deps.root, 'backup', `pre_${manifest.version}_${Date.now()}`);
  const current = join(deps.root, 'current');
  mkdirSync(staging, { recursive: true });
  mkdirSync(backup, { recursive: true });
  writeFileSync(join(staging, 'payload.bin'), payload);
  writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));

  if (existsSync(current)) {
    // shallow backup marker
    writeFileSync(join(backup, 'BACKUP_OK'), new Date().toISOString());
    if (existsSync(join(current, 'manifest.json'))) {
      copyFileSync(join(current, 'manifest.json'), join(backup, 'manifest.json'));
    }
  }

  try {
    await deps.activate(staging);
    mkdirSync(current, { recursive: true });
    writeFileSync(join(current, 'manifest.json'), JSON.stringify(manifest, null, 2));
    const health = await deps.healthCheck();
    if (!health.ok) {
      await deps.restoreBackup(backup);
      return {
        ok: true,
        version: manifest.version,
        rolled_back: true,
        reason: health.reason || 'health check FAIL → ROLLBACK',
      };
    }
    // atomic-ish: rename staging marker
    const active = join(deps.root, 'active_version');
    writeFileSync(`${active}.tmp`, manifest.version);
    renameSync(`${active}.tmp`, active);
    return { ok: true, version: manifest.version, rolled_back: false };
  } catch (e) {
    try {
      await deps.restoreBackup(backup);
    } catch {
      /* keep original error */
    }
    rmSync(staging, { recursive: true, force: true });
    return {
      ok: false,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

export function readFileSha256(path: string): string {
  return sha256Buffer(readFileSync(path));
}
