const SHORTENERS = [
  'bit.ly',
  't.co',
  'tinyurl.com',
  'cutt.ly',
  'goo.gl',
  'ow.ly',
  'is.gd',
  'v.gd',
  'buff.ly',
  'rebrand.ly',
  'shorturl.at',
  't.ly',
  'rb.gy',
  'tiny.cc',
  'clck.ru',
  'vk.cc',
  'lnkd.in',
  's.id',
  'trib.al',
  'bl.ink',
  'soo.gd',
  'qr.ae',
  'adf.ly',
  'bit.do',
  'mcaf.ee',
  'shorturl.com',
  'x.co',
  'po.st',
  'su.pr',
  'u.to',
  'cli.re',
  'l.ead.me',
  'short.io',
  'tr.ee',
  'lnk.to',
  'urlz.fr',
  'git.io',
  'amzn.to',
  'youtu.be',
];

export type LinkError = 'invalid' | 'not_https' | 'shortener' | 'credentials' | 'too_long';

export type LinkResult = { ok: true; url: string; domain: string; trusted: boolean } | { ok: false; error: LinkError };

const matchesDomain = (host: string, base: string) => host === base || host.endsWith(`.${base}`);

export function isShortener(host: string): boolean {
  return SHORTENERS.some((s) => matchesDomain(host, s));
}

/** Домен доверенный, если совпадает с записью списка или является её поддоменом. */
export function isTrustedDomain(host: string, trusted: readonly string[]): boolean {
  return trusted.some((d) => matchesDomain(host, d.toLowerCase()));
}

export function validateLink(input: string, trusted: readonly string[]): LinkResult {
  const raw = input.trim();
  if (!raw || /\s/.test(raw)) return { ok: false, error: 'invalid' };
  if (raw.length > 2048) return { ok: false, error: 'too_long' };

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: 'invalid' };
  }
  if (u.protocol !== 'https:') return { ok: false, error: u.protocol === 'http:' ? 'not_https' : 'invalid' };
  if (u.username || u.password) return { ok: false, error: 'credentials' };

  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
  if (!host.includes('.') || isIp) return { ok: false, error: 'invalid' };
  if (isShortener(host)) return { ok: false, error: 'shortener' };

  const domain = host.replace(/^www\./, '');
  return { ok: true, url: u.href, domain, trusted: isTrustedDomain(domain, trusted) };
}
