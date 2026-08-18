import { describe, expect, it } from 'vitest';
import {
  AccessSecretError,
  chooseAccessSecret,
  generateAccessCode,
  hashAccessCode,
  verifyAccessCode,
} from './accessCode.js';

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

  it('chooseAccessSecret keeps an operator-chosen password', () => {
    const out = chooseAccessSecret('ManaParole1');
    expect(out).toEqual({ secret: 'ManaParole1', generated: false });
    const hash = hashAccessCode(out.secret);
    expect(verifyAccessCode('ManaParole1', hash)).toBe(true);
  });

  it('chooseAccessSecret generates when blank', () => {
    const out = chooseAccessSecret('  ');
    expect(out.generated).toBe(true);
    expect(out.secret).toHaveLength(12);
  });

  it('chooseAccessSecret rejects too-short passwords', () => {
    expect(() => chooseAccessSecret('ab')).toThrow(AccessSecretError);
  });
});
