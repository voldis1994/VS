import { describe, expect, it } from 'vitest';
import { generateAccessCode, hashAccessCode, verifyAccessCode } from './accessCode.js';

describe('accessCode', () => {
  it('hashes and verifies a valid access code', () => {
    const code = generateAccessCode();
    const hash = hashAccessCode(code);
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(verifyAccessCode(code, hash)).toBe(true);
  });

  it('rejects an invalid access code', () => {
    const hash = hashAccessCode('GOODCODE1234');
    expect(verifyAccessCode('BADCODE99999', hash)).toBe(false);
    expect(verifyAccessCode('', hash)).toBe(false);
    expect(verifyAccessCode('GOODCODE1234', null)).toBe(false);
  });

  it('generateAccessCode returns 12-char human code', () => {
    const code = generateAccessCode();
    expect(code).toHaveLength(12);
    expect(/^[A-Z2-9]+$/.test(code)).toBe(true);
  });
});
