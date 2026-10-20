// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createAuthFailureLimiter } from './auth';

describe('remote gateway auth failure limiter', () => {
  it('blocks an IP after repeated failures and releases after the block window', () => {
    const limiter = createAuthFailureLimiter({ maxFailures: 3, windowMs: 1000, blockMs: 5000 });
    limiter.recordFailure('1.2.3.4', 0);
    limiter.recordFailure('1.2.3.4', 10);
    expect(limiter.isBlocked('1.2.3.4', 20)).toBe(false);
    limiter.recordFailure('1.2.3.4', 30);
    expect(limiter.isBlocked('1.2.3.4', 40)).toBe(true);
    expect(limiter.isBlocked('5.6.7.8', 40)).toBe(false);
    expect(limiter.isBlocked('1.2.3.4', 5031)).toBe(false);
  });

  it('resets the counter after a success or an expired window', () => {
    const limiter = createAuthFailureLimiter({ maxFailures: 2, windowMs: 1000, blockMs: 5000 });
    limiter.recordFailure('ip', 0);
    limiter.recordSuccess('ip');
    limiter.recordFailure('ip', 10);
    expect(limiter.isBlocked('ip', 20)).toBe(false);
    limiter.recordFailure('ip', 2000);
    expect(limiter.isBlocked('ip', 2001)).toBe(false);
  });
});
