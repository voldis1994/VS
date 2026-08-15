import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const UNSAFE_DEFAULT = 'CHANGE_ME_32_BYTE_HEX_OR_BASE64_KEY_HERE';

export class EncryptionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionKeyError';
  }
}

/** True when key is missing or a known unsafe placeholder. Never log the key. */
export function isUnsafeMasterEncryptionKey(secret: string | undefined | null): boolean {
  const s = String(secret || '').trim();
  if (!s) return true;
  if (s === UNSAFE_DEFAULT) return true;
  if (s.includes('CHANGE_ME')) return true;
  if (s.length < 16) return true;
  return false;
}

function getKey(): Buffer {
  const secret = process.env.MASTER_ENCRYPTION_KEY;
  if (isUnsafeMasterEncryptionKey(secret)) {
    throw new EncryptionKeyError(
      'MASTER_ENCRYPTION_KEY_REQUIRED: set a strong unique MASTER_ENCRYPTION_KEY (refusing default/CHANGE_ME/short key)'
    );
  }
  return scryptSync(String(secret).trim(), 'market-reader-salt', 32);
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

export function decrypt(ciphertext: string, iv: string, tag: string): string {
  const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export function maskSecret(value: string): string {
  if (value.length <= 4) return '••••';
  return '••••••••••' + value.slice(-4);
}
