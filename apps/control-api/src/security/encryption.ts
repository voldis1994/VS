import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
/** Legacy default — many installs encrypted broker secrets with this value. */
const PLACEHOLDER = 'CHANGE_ME_32_BYTE_HEX_OR_BASE64_KEY_HERE';

export function isEncryptionKeyConfigured(): boolean {
  const secret = String(process.env.MASTER_ENCRYPTION_KEY || '').trim();
  return Boolean(secret) && secret !== PLACEHOLDER && !secret.startsWith('CHANGE_ME');
}

function keyFromSecret(secret: string): Buffer {
  const s = secret.trim() || PLACEHOLDER;
  return scryptSync(s, 'market-reader-salt', 32);
}

function activeSecret(): string {
  const secret = String(process.env.MASTER_ENCRYPTION_KEY || '').trim();
  return secret || PLACEHOLDER;
}

function getKey(): Buffer {
  const secret = activeSecret();
  if (secret === PLACEHOLDER || secret.startsWith('CHANGE_ME')) {
    // Do NOT refuse — VS installs used this as the live envelope key for years.
    if (!(globalThis as { __mrEncWarned?: boolean }).__mrEncWarned) {
      (globalThis as { __mrEncWarned?: boolean }).__mrEncWarned = true;
      console.warn(
        '[security] MASTER_ENCRYPTION_KEY is placeholder/legacy — decrypt still works'
      );
    }
  }
  return keyFromSecret(secret);
}

export function encrypt(plaintext: string): { ciphertext: string; iv: string; tag: string } {
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag();
  return {
    ciphertext: encrypted,
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
  };
}

function decryptWithKey(
  key: Buffer,
  ciphertext: string,
  iv: string,
  tag: string
): string {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export function decrypt(ciphertext: string, iv: string, tag: string): string {
  try {
    return decryptWithKey(getKey(), ciphertext, iv, tag);
  } catch (first) {
    // If VS.bat rotated CHANGE_ME → random, still open secrets sealed with legacy key.
    const current = activeSecret();
    if (current !== PLACEHOLDER) {
      try {
        return decryptWithKey(keyFromSecret(PLACEHOLDER), ciphertext, iv, tag);
      } catch {
        /* fall through */
      }
    }
    throw first;
  }
}

export function maskSecret(value: string): string {
  if (value.length <= 4) return '••••';
  return '••••••••••' + value.slice(-4);
}
