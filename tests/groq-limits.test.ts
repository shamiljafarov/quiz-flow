import { describe, expect, it } from 'vitest';
import { estimateTokens, parseRetryMs } from '../lib/groq-limits';

describe('Groq limit helpers', () => {
  it('uses seconds from the 429 message', () => {
    expect(parseRetryMs('Please try again in 6.119999999s.')).toBe(6120);
  });
  it('handles minutes, milliseconds and Retry-After header', () => {
    expect(parseRetryMs('retry after 1.5 minutes')).toBe(90_000);
    expect(parseRetryMs('try again in 250ms')).toBe(250);
    expect(parseRetryMs('unknown', '7')).toBe(7000);
  });
  it('returns null when duration is unknown', () => {
    expect(parseRetryMs('rate limit reached')).toBeNull();
  });
  it('estimates more tokens for longer material', () => {
    expect(estimateTokens('A'.repeat(7000), 1500)).toBeGreaterThan(estimateTokens('short', 1500));
  });
});
