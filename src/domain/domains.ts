/** Нормализация домена из ввода админа: «https://Checkout.Stripe.com/x» -> «checkout.stripe.com». */
export function normalizeDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.split(/[/?#]/)[0] ?? '';
  s = s.replace(/^www\./, '').replace(/\.$/, '');
  if (!/^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(s)) return null;
  return s;
}

export const DEFAULT_TRUSTED_DOMAINS = [
  'checkout.stripe.com',
  'paddle.com',
  'lemonsqueezy.com',
  'paypal.com',
  'fastspring.com',
];
