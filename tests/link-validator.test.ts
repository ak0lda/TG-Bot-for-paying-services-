import { describe, expect, it } from 'vitest';
import { isTrustedDomain, validateLink } from '../src/domain/link-validator.js';

const trusted = ['checkout.stripe.com', 'paddle.com', 'paypal.com'];

describe('validateLink', () => {
  it('accepts https and flags trusted domains (incl. subdomains)', () => {
    const r = validateLink('https://checkout.stripe.com/c/pay/cs_live_abc#frag', trusted);
    expect(r).toMatchObject({ ok: true, domain: 'checkout.stripe.com', trusted: true });
    expect(validateLink('https://pay.paddle.com/checkout/1', trusted)).toMatchObject({ ok: true, trusted: true });
    expect(validateLink('https://www.PayPal.com/x', trusted)).toMatchObject({ ok: true, domain: 'paypal.com', trusted: true });
  });

  it('marks unknown domains as untrusted but valid', () => {
    expect(validateLink('https://some-shop.io/pay?id=1', trusted)).toMatchObject({ ok: true, trusted: false });
  });

  it('does not trust look-alike domains', () => {
    expect(validateLink('https://evilpaypal.com/x', trusted)).toMatchObject({ ok: true, trusted: false });
    expect(validateLink('https://paypal.com.evil.io/x', trusted)).toMatchObject({ ok: true, trusted: false });
    expect(validateLink('https://paypal.com@evil.io/x', trusted)).toMatchObject({ ok: false });
  });

  it('rejects http, junk and non-http schemes', () => {
    expect(validateLink('http://paypal.com/x', trusted)).toEqual({ ok: false, error: 'not_https' });
    expect(validateLink('paypal.com/x', trusted)).toEqual({ ok: false, error: 'invalid' });
    expect(validateLink('javascript:alert(1)', trusted)).toEqual({ ok: false, error: 'invalid' });
    expect(validateLink('ftp://x.com/a', trusted)).toEqual({ ok: false, error: 'invalid' });
    expect(validateLink('https://a.com/x y', trusted)).toEqual({ ok: false, error: 'invalid' });
    expect(validateLink('', trusted)).toEqual({ ok: false, error: 'invalid' });
  });

  it('rejects IPs, single-label hosts, credentials and huge urls', () => {
    expect(validateLink('https://127.0.0.1/x', trusted)).toEqual({ ok: false, error: 'invalid' });
    expect(validateLink('https://localhost/x', trusted)).toEqual({ ok: false, error: 'invalid' });
    expect(validateLink('https://user:pw@shop.com/x', trusted)).toEqual({ ok: false, error: 'credentials' });
    expect(validateLink(`https://shop.com/${'a'.repeat(3000)}`, trusted)).toEqual({ ok: false, error: 'too_long' });
  });

  it.each(['https://bit.ly/abc', 'https://t.co/x', 'https://tinyurl.com/y', 'https://cutt.ly/z', 'https://www.bit.ly/q'])(
    'rejects shortener %s',
    (u) => expect(validateLink(u, trusted)).toEqual({ ok: false, error: 'shortener' }),
  );
});

describe('isTrustedDomain', () => {
  it('matches exact and subdomain only', () => {
    expect(isTrustedDomain('paddle.com', trusted)).toBe(true);
    expect(isTrustedDomain('a.b.paddle.com', trusted)).toBe(true);
    expect(isTrustedDomain('notpaddle.com', trusted)).toBe(false);
  });
});
