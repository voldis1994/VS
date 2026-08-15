/**
 * Backup — database/config/strategy/client metadata. Secrets only encrypted.
 * A backup that cannot restore is not a backup — restore is tested in unit tests.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'fs';
import { join } from 'path';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';

export type BackupManifest = {
  id: string;
  created_at: string;
  files: string[];
  retention_keep: number;
};

export function encryptSecret(plaintext: string, key32: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key32, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptSecret(blobB64: string, key32: Buffer): string {
  const buf = Buffer.from(blobB64, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key32, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function createBackup(
  root: string,
  payload: Record<string, string>,
  opts: { retention_keep?: number; secretKey?: Buffer; secrets?: Record<string, string> }
): BackupManifest {
  const id = `bak_${Date.now()}`;
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  for (const [name, content] of Object.entries(payload)) {
    const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_');
    writeFileSync(join(dir, safe), content, 'utf8');
    files.push(safe);
  }
  if (opts.secrets && opts.secretKey) {
    for (const [name, secret] of Object.entries(opts.secrets)) {
      const safe = `secret_${name.replace(/[^a-zA-Z0-9._-]/g, '_')}.enc`;
      writeFileSync(join(dir, safe), encryptSecret(secret, opts.secretKey), 'utf8');
      files.push(safe);
    }
  }
  const manifest: BackupManifest = {
    id,
    created_at: new Date().toISOString(),
    files,
    retention_keep: opts.retention_keep ?? 7,
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  enforceRetention(root, manifest.retention_keep);
  return manifest;
}

export function restoreBackup(
  root: string,
  id: string,
  opts?: { secretKey?: Buffer }
): { ok: boolean; files: Record<string, string>; secrets: Record<string, string>; reason?: string } {
  const dir = join(root, id);
  const manPath = join(dir, 'manifest.json');
  if (!existsSync(manPath)) return { ok: false, files: {}, secrets: {}, reason: 'manifest missing' };
  const manifest = JSON.parse(readFileSync(manPath, 'utf8')) as BackupManifest;
  const files: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const f of manifest.files) {
    const p = join(dir, f);
    if (!existsSync(p)) return { ok: false, files, secrets, reason: `missing ${f}` };
    const content = readFileSync(p, 'utf8');
    if (f.startsWith('secret_') && f.endsWith('.enc')) {
      if (!opts?.secretKey) return { ok: false, files, secrets, reason: 'secret key required' };
      const name = f.replace(/^secret_/, '').replace(/\.enc$/, '');
      secrets[name] = decryptSecret(content, opts.secretKey);
    } else {
      files[f] = content;
    }
  }
  return { ok: true, files, secrets };
}

function enforceRetention(root: string, keep: number): void {
  if (!existsSync(root)) return;
  const dirs = readdirSync(root)
    .map((n) => join(root, n))
    .filter((p) => statSync(p).isDirectory())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const d of dirs.slice(keep)) {
    rmSync(d, { recursive: true, force: true });
  }
}

export function backupKeyFromPassphrase(pass: string): Buffer {
  return createHash('sha256').update(pass).digest();
}
