import { describe, expect, it } from 'vitest';
import { humanizeApiNetworkError } from './apiNetworkError';

describe('humanizeApiNetworkError', () => {
  it('maps Failed to fetch to actionable Latvian message', () => {
    const err = humanizeApiNetworkError(new TypeError('Failed to fetch'));
    expect(err.message).toMatch(/API nereaģē/);
    expect(err.message).toMatch(/Failed to fetch/);
    expect(err.message).toMatch(/VS\.bat|MR-ControlAPI/);
  });

  it('maps AbortError to timeout message', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(humanizeApiNetworkError(abort).message).toMatch(/API timeout/);
  });

  it('passes through other errors', () => {
    expect(humanizeApiNetworkError(new Error('Soft CAP 2.2')).message).toBe('Soft CAP 2.2');
  });
});
