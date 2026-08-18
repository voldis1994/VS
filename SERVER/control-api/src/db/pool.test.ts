import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { isRetryableDbError } from './pool.js';

const poolSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'pool.ts'), 'utf8');

describe('isRetryableDbError', () => {
  it('retries ECONNREFUSED from pg-pool (Docker Engine OK but :5432 down)', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'ECONNREFUSED',
    });
    expect(isRetryableDbError(err)).toBe(true);
    expect(isRetryableDbError(new AggregateError([err], 'ECONNREFUSED'))).toBe(true);
    expect(isRetryableDbError('Error: connect ECONNREFUSED ::1:5432')).toBe(true);
  });

  it('retries while postgres is still starting', () => {
    expect(isRetryableDbError(new Error('the database system is starting up'))).toBe(true);
    expect(isRetryableDbError(new Error('connect ETIMEDOUT'))).toBe(true);
  });

  it('does not retry auth failures', () => {
    expect(isRetryableDbError(new Error('password authentication failed for user "market_reader"'))).toBe(
      false
    );
  });
});

describe('single-box DB env', () => {
  it('does not let i3 server.env override MSI single-box.env', () => {
    expect(poolSrc).toMatch(/VS_SINGLE_BOX/);
    expect(poolSrc).toMatch(/single-box\.env/);
    expect(poolSrc).toMatch(/if \(!envFlag\(process\.env\.VS_SINGLE_BOX\)\)/);
  });
});
