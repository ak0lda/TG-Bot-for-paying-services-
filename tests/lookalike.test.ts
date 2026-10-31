import { describe, expect, it } from 'vitest';
import { analyzeDomain, brandOf, levenshtein, normalizeConfusables, registrable } from '../src/domain/lookalike.js';

const trusted = ['checkout.stripe.com', 'paddle.com', 'lemonsqueezy.com', 'paypal.com', 'fastspring.com'];
const codes = (d: string) => analyzeDomain(d, trusted).map((f) => (f.code === 'LOOKALIKE' ? `LOOKALIKE:${f.trusted}` : f.code));

describe('domain helpers', () => {
  it('registrable / brand', () => {
    expect(registrable('checkout.stripe.com')).toBe('stripe.com');
    expect(registrable('a.b.shop.co.uk')).toBe('shop.co.uk');
    expect(brandOf('checkout.stripe.com')).toBe('stripe');
    expect(brandOf('www.shop.co.uk')).toBe('shop');
    expect(levenshtein('paypal', 'paypa1')).toBe(1);
    expect(levenshtein('stripe', 'stirpe')).toBe(1); // перестановка соседних букв
    expect(levenshtein('abc', 'xyz')).toBe(3);
    expect(normalizeConfusables('PayPa1')).toBe('paypal');
    expect(normalizeConfusables('rnicrosoft')).toBe('microsoft');
  });
});

describe('analyzeDomain', () => {
  it.each(['paypa1.com', 'paypal.net', 'paypall.com', 'pay-pal.com', 'stirpe.com', 'paypal-secure-login.com', 'lemonsqueezy.shop'])(
    'flags look-alike %s',
    (d) => expect(codes(d).some((c) => c.startsWith('LOOKALIKE'))).toBe(true),
  );

  it('names the genuine domain it imitates', () => {
    expect(codes('paypa1.com')).toEqual(['LOOKALIKE:paypal.com']);
    expect(codes('stirpe.com')).toEqual(['LOOKALIKE:stripe.com']);
  });

  it('does not flag genuine domains, their subdomains, or unrelated sites', () => {
    for (const d of ['paypal.com', 'www.paypal.com', 'checkout.stripe.com', 'pay.paddle.com', 'netflix.com', 'hetzner.com', 'github.com', 'openai.com']) {
      expect(codes(d), d).toEqual([]);
    }
  });

  it('flags punycode (possible homograph attack) even when no brand matches', () => {
    expect(codes('xn--pypal-4ve.com')).toContain('PUNYCODE');
    expect(codes('shop.xn--80ak6aa92e.com')).toContain('PUNYCODE');
  });

  it('short brands are ignored to avoid noise', () => {
    expect(analyzeDomain('abcd.com', ['abc.com'])).toEqual([]);
  });
});
