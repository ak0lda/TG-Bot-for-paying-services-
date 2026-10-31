import type { Db } from '../db/client.js';
import type { Logger } from '../logger.js';
import { safeError } from '../logging/safe-error.js';
import { analyzeDomain } from '../domain/lookalike.js';

export interface LinkCheck {
  /** Домен в чёрном списке — заявку не принимаем (причина для клиента не раскрывается). */
  blocked: string | null;
  /** Коды рисков: SAFE_BROWSING:<тип> | LOOKALIKE:<домен> | PUNYCODE. Заявка принимается, админ видит предупреждение. */
  risks: string[];
}

const SB_URL = 'https://safebrowsing.googleapis.com/v4/threatMatches:find';
const CACHE_MS = 6 * 3_600_000;

/** «a.b.evil.com» -> [«a.b.evil.com», «b.evil.com», «evil.com»]. */
export function domainCandidates(domain: string): string[] {
  const labels = domain.toLowerCase().split('.');
  const out: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join('.'));
  return out;
}

export class LinkSafetyService {
  private cache = new Map<string, { at: number; threats: string[] }>();

  constructor(
    private readonly db: Db,
    private readonly log: Pick<Logger, 'warn'>,
    private readonly opts: { apiKey?: string | undefined; fetchFn?: typeof fetch; now?: () => number } = {},
  ) {}

  // ── Чёрный список ───────────────────────────────────────────
  async ban(domain: string, reason?: string): Promise<boolean> {
    const res = await this.db.blockedDomain.createMany({
      data: [{ domain, reason: reason ?? null }],
      skipDuplicates: true,
    });
    return res.count === 1;
  }
  async unban(domain: string): Promise<boolean> {
    return (await this.db.blockedDomain.deleteMany({ where: { domain } })).count === 1;
  }
  listBanned() {
    return this.db.blockedDomain.findMany({ orderBy: { domain: 'asc' } });
  }

  /** Проверка домена ссылки. Сетевые сбои Safe Browsing не блокируют заявку (fail-open), но пишутся в лог. */
  async check(domain: string, trustedDomains: readonly string[]): Promise<LinkCheck> {
    const banned = await this.db.blockedDomain.findFirst({ where: { domain: { in: domainCandidates(domain) } } });
    if (banned) return { blocked: banned.reason ?? banned.domain, risks: [] };

    const risks: string[] = [];
    for (const f of analyzeDomain(domain, trustedDomains))
      risks.push(f.code === 'LOOKALIKE' ? `LOOKALIKE:${f.trusted}` : f.code);
    for (const t of await this.safeBrowsing(domain)) risks.push(`SAFE_BROWSING:${t}`);
    return { blocked: null, risks };
  }

  /**
   * Google Safe Browsing. Отправляем ТОЛЬКО домен (https://домен/): полный адрес оплаты содержит идентификатор
   * сессии/токен, его третьим лицам отдавать нельзя. Результат кешируется на 6 часов.
   */
  private async safeBrowsing(domain: string): Promise<string[]> {
    const key = this.opts.apiKey;
    if (!key) return [];
    const now = (this.opts.now ?? Date.now)();
    const hit = this.cache.get(domain);
    if (hit && now - hit.at < CACHE_MS) return hit.threats;
    try {
      const res = await (this.opts.fetchFn ?? fetch)(`${SB_URL}?key=${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(3000),
        body: JSON.stringify({
          client: { clientId: 'payments-bot', clientVersion: '1.0' },
          threatInfo: {
            threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'],
            platformTypes: ['ANY_PLATFORM'],
            threatEntryTypes: ['URL'],
            threatEntries: [{ url: `https://${domain}/` }],
          },
        }),
      });
      if (!res.ok) throw new Error(`Safe Browsing HTTP ${res.status}`);
      const json = (await res.json()) as { matches?: Array<{ threatType?: string }> };
      const threats = [...new Set((json.matches ?? []).map((m) => m.threatType).filter((t): t is string => !!t))];
      this.cache.set(domain, { at: now, threats });
      return threats;
    } catch (e) {
      this.log.warn(safeError(e), 'safe browsing check failed');
      return [];
    }
  }
}
