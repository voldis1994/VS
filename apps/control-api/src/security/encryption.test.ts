import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, maskSecret } from './encryption.js';

describe('encryption', () => {
  it('encrypts and decrypts', () => {
    process.env.MASTER_ENCRYPTION_KEY = 'test-key-for-encryption-tests';
    const original = 'my-secret-api-key-12345';
    const enc = encrypt(original);
    const dec = decrypt(enc.ciphertext, enc.iv, enc.tag);
    expect(dec).toBe(original);
  });

  it('masks secrets', () => {
    const masked = maskSecret('ABCDEF12345');
    expect(masked).toContain('••••');
    expect(masked.endsWith('2345')).toBe(true);
  });
});
