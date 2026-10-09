import { describe, expect, it } from 'vitest';
import { normalizeDomain } from '../src/domain/domains.js';
import { generateInviteCode, isValidInviteCodeFormat } from '../src/domain/invite-code.js';
import { RateLimiter } from '../src/services/rate-limiter.js';

describe('normalizeDomain', () => {
  it.each([
    ['https://Checkout.Stripe.com/pay/abc?x=1', 'checkout.stripe.com'],
    ['www.paypal.com', 'paypal.com'],
    ['paddle.com.', 'paddle.com'],
  ])('%s -> %s', (i, o) => expect(normalizeDomain(i)).toBe(o));

  it.each(['', 'localhost', 'not a domain', 'a..b.com', '-x.com', 'foo'])('rejects %j', (i) =>
    expect(normalizeDomain(i)).toBeNull(),
  );
});

describe('invite code', () => {
  it('generates valid unique url-safe codes', () => {
    const a = generateInviteCode();
    expect(isValidInviteCodeFormat(a)).toBe(true);
    expect(a).not.toBe(generateInviteCode());
  });
  it('rejects malformed payloads', () => {
    for (const bad of ['', 'short', 'has space!!', "x'; DROP TABLE", 'a'.repeat(65)]) {
      expect(isValidInviteCodeFormat(bad)).toBe(false);
    }
  });
});

describe('RateLimiter', () => {
  it('allows a burst then throttles and refills', () => {
    let now = 0;
    const rl = new RateLimiter(3, 1, () => now);
    expect([rl.allow('a'), rl.allow('a'), rl.allow('a'), rl.allow('a')]).toEqual([true, true, true, false]);
    expect(rl.allow('b')).toBe(true); // отдельный ключ
    now += 1000;
    expect(rl.allow('a')).toBe(true);
    expect(rl.allow('a')).toBe(false);
  });
});
