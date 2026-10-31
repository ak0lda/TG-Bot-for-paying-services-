// Подозрительные домены: подмена символов (punycode / похожие буквы), опечатки известных брендов, «бренд-ловушки».
// Это эвристика для предупреждения админа, а не вердикт: легальный домен может сработать, поэтому только пометка.

const TWO_LEVEL_TLDS = new Set(['co.uk', 'org.uk', 'com.au', 'co.jp', 'co.nz', 'com.br', 'co.in', 'com.tr', 'co.za']);

/** Регистрируемая часть домена: «checkout.stripe.com» -> «stripe.com», «a.b.co.uk» -> «b.co.uk». */
export function registrable(host: string): string {
  const labels = host.toLowerCase().split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const last2 = labels.slice(-2).join('.');
  return TWO_LEVEL_TLDS.has(last2) ? labels.slice(-3).join('.') : last2;
}

/** «paypal.com» -> «paypal». */
export function brandOf(host: string): string {
  const reg = registrable(host).split('.');
  return (reg.length >= 3 && TWO_LEVEL_TLDS.has(reg.slice(-2).join('.')) ? reg.slice(0, -2) : reg.slice(0, -1)).join('.');
}

/** Расстояние Дамерау — Левенштейна (перестановка двух соседних букв — одна правка): stripe ↔ stirpe = 1. */
export function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) dp[i]![j] = Math.min(dp[i]![j]!, dp[i - 2]![j - 2]! + 1);
    }
  }
  return dp[a.length]![b.length]!;
}

/** Приводит «похожие» символы к одному виду: paypa1 -> paypal, rnicrosoft -> microsoft. */
export function normalizeConfusables(s: string): string {
  return s
    .toLowerCase()
    .replace(/rn/g, 'm')
    .replace(/vv/g, 'w')
    .replace(/[0]/g, 'o')
    .replace(/[1|]/g, 'l')
    .replace(/[5]/g, 's')
    .replace(/ı/g, 'i')
    .replace(/[-_]/g, '');
}

export type DomainFinding = { code: 'PUNYCODE' } | { code: 'LOOKALIKE'; trusted: string };

export function analyzeDomain(domain: string, trustedDomains: readonly string[]): DomainFinding[] {
  const host = domain.toLowerCase();
  const out: DomainFinding[] = [];
  if (host.split('.').some((l) => l.startsWith('xn--'))) out.push({ code: 'PUNYCODE' });

  const myReg = registrable(host);
  const myBrand = brandOf(host);
  const seen = new Set<string>();
  for (const t of trustedDomains) {
    const tReg = registrable(t);
    if (seen.has(tReg)) continue;
    seen.add(tReg);
    if (host === tReg || host.endsWith(`.${tReg}`)) continue; // настоящий домен или его поддомен
    const tBrand = brandOf(t);
    if (tBrand.length < 4) continue; // слишком короткие бренды дают шум
    const tolerance = tBrand.length >= 8 ? 2 : 1;
    const similar =
      myBrand === tBrand || // тот же бренд в другой зоне: paypal.net
      normalizeConfusables(myBrand) === normalizeConfusables(tBrand) || // paypa1.com
      (tBrand.length >= 5 && levenshtein(myBrand, tBrand) <= tolerance) || // опечатка: stirpe.com
      (tBrand.length >= 5 && myBrand.includes(tBrand) && myReg !== tReg); // paypal-secure-login.com
    if (similar) out.push({ code: 'LOOKALIKE', trusted: tReg });
  }
  return out;
}
