/**
 * WireGuard key helpers — private keys NEVER written under the git repo.
 * Production: prefer `wg genkey`/`wg pubkey`. Tests: Node x25519 → WG-compatible base64.
 */

import { execFileSync } from 'child_process';
import { generateKeyPairSync, createPublicKey, createPrivateKey } from 'crypto';
import { createHash, randomBytes } from 'crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'fs';
import { dirname, join } from 'path';

export type WgKeyPair = {
  privateKey: string; // base64
  publicKey: string; // base64
  fingerprint: string; // sha256 of public key (hex short)
};

export function fingerprintPublicKey(publicKeyB64: string): string {
  return createHash('sha256').update(publicKeyB64).digest('hex').slice(0, 16);
}

function nodeX25519Pair(): WgKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const privDer = privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer;
  const pubDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  // PKCS8 x25519 private key: last 32 bytes are the seed; SPKI: last 32 are public
  const privRaw = privDer.subarray(privDer.length - 32);
  const pubRaw = pubDer.subarray(pubDer.length - 32);
  const privateKeyB64 = privRaw.toString('base64');
  const publicKeyB64 = pubRaw.toString('base64');
  return {
    privateKey: privateKeyB64,
    publicKey: publicKeyB64,
    fingerprint: fingerprintPublicKey(publicKeyB64),
  };
}

export function generateWgKeyPair(): WgKeyPair {
  try {
    const priv = execFileSync('wg', ['genkey'], { encoding: 'utf8' }).trim();
    const pub = execFileSync('wg', ['pubkey'], {
      encoding: 'utf8',
      input: priv + '\n',
    }).trim();
    return { privateKey: priv, publicKey: pub, fingerprint: fingerprintPublicKey(pub) };
  } catch {
    return nodeX25519Pair();
  }
}

/** Write private key ONLY under dataRoot (outside git). */
export function writePrivateKeyFile(dataRoot: string, deviceId: string, privateKey: string): string {
  const path = join(dataRoot, 'network', 'keys', `${deviceId}.private`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, privateKey + '\n', { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* windows */
  }
  return path;
}

export function readPrivateKeyFile(dataRoot: string, deviceId: string): string | null {
  const path = join(dataRoot, 'network', 'keys', `${deviceId}.private`);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8').trim();
}

export function assertPathOutsideRepo(dataRoot: string, repoRootHint?: string): void {
  const normalized = dataRoot.replace(/\\/g, '/');
  if (normalized.includes('/.git/') || normalized.endsWith('/.git')) {
    throw new Error('PRIVATE_KEY_PATH_INVALID');
  }
  if (repoRootHint && normalized.startsWith(repoRootHint.replace(/\\/g, '/') + '/SERVER')) {
    // Allow only under explicit data dirs, not source tree
    if (!normalized.includes('/data/') && !normalized.includes('/var/lib/')) {
      throw new Error('PRIVATE_KEY_MUST_NOT_LIVE_IN_SOURCE_TREE');
    }
  }
}

export function randomDeviceToken(): string {
  return randomBytes(32).toString('base64url');
}
