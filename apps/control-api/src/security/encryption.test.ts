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

  it('still decrypts legacy CHANGE_ME envelope key', () => {
    process.env.MASTER_ENCRYPTION_KEY = 'CHANGE_ME_32_BYTE_HEX_OR_BASE64_KEY_HERE';
    const enc = encrypt('broker-secret');
    expect(decrypt(enc.ciphertext, enc.iv, enc.tag)).toBe('broker-secret');
  });

  it('decrypt falls back to legacy key after rotation', () => {
    process.env.MASTER_ENCRYPTION_KEY = 'CHANGE_ME_32_BYTE_HEX_OR_BASE64_KEY_HERE';
    const enc = encrypt('old-sealed');
    process.env.MASTER_ENCRYPTION_KEY = 'rotated-random-key-abcdef';
    expect(decrypt(enc.ciphertext, enc.iv, enc.tag)).toBe('old-sealed');
  });
});
