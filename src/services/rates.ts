import type { Db } from '../db/client.js';
import type { Logger } from '../logger.js';
import { RATE_DECIMALS, RATE_SCALE, parseRate } from '../domain/pricing.js';
import { parseDecimalToMinor } from '../domain/money.js';
import { safeError } from '../logging/safe-error.js';

export type RateSource = 'CBR' | 'MANUAL';

export interface RateInfo {
  currency: string;
  scaled: bigint;
  source: RateSource;
  at: Date;
}

export interface RatesProvider {
  getRate(currency: string): Promise<RateInfo>;
}

export class RateUnavailableError extends Error {
  constructor(readonly currency: string) {
    super(`No rate for ${currency}`);
  }
}

const CBR_URL = 'https://www.cbr.ru/scripts/XML_daily.asp';
const CACHE_TTL_MS = 60 * 60 * 1000;
const manualKey = (c: string) => `manualRate:${c}`;

/** Разбор XML ЦБ РФ: курс за 1 единицу валюты в рублях, масштаб 1e8. */
export function parseCbrXml(xml: string): Map<string, bigint> {
  const result = new Map<string, bigint>();
  for (const block of xml.matchAll(/<Valute\b[^>]*>([\s\S]*?)<\/Valute>/g)) {
    const body = block[1] ?? '';
    const code = /<CharCode>([A-Z]{3})<\/CharCode>/.exec(body)?.[1];
    const nominal = /<Nominal>(\d+)<\/Nominal>/.exec(body)?.[1];
    const value = /<Value>([\d\s.,]+)<\/Value>/.exec(body)?.[1];
    if (!code || !nominal || !value) continue;
    const nom = BigInt(nominal);
    if (nom <= 0n) continue;
    const scaled = parseDecimalToMinor(value, RATE_DECIMALS) / nom;
    if (scaled > 0n) result.set(code, scaled);
  }
  return result;
}

export class RatesService implements RatesProvider {
  private cache: { rates: Map<string, bigint>; fetchedAt: Date } | null = null;

  constructor(
    private readonly db: Db,
    private readonly log: Logger,
    private readonly fetchXml: () => Promise<string> = defaultFetchXml,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Ручной курс приоритетнее ЦБ. */
  async getRate(currency: string): Promise<RateInfo> {
    const code = currency.toUpperCase();
    if (code === 'RUB') return { currency: code, scaled: RATE_SCALE, source: 'CBR', at: this.now() };

    const manual = await this.db.setting.findUnique({ where: { key: manualKey(code) } });
    if (manual && typeof manual.value === 'string') {
      return { currency: code, scaled: BigInt(manual.value), source: 'MANUAL', at: manual.updatedAt };
    }

    const cache = await this.loadCbr();
    const scaled = cache?.rates.get(code);
    if (!cache || !scaled) throw new RateUnavailableError(code);
    return { currency: code, scaled, source: 'CBR', at: cache.fetchedAt };
  }

  async setManual(currency: string, input: string): Promise<bigint> {
    const scaled = parseRate(input);
    const key = manualKey(currency.toUpperCase());
    await this.db.setting.upsert({ where: { key }, create: { key, value: scaled.toString() }, update: { value: scaled.toString() } });
    return scaled;
  }

  async clearManual(currency: string): Promise<void> {
    await this.db.setting.deleteMany({ where: { key: manualKey(currency.toUpperCase()) } });
  }

  async listManual(): Promise<Array<{ currency: string; scaled: bigint }>> {
    const rows = await this.db.setting.findMany({ where: { key: { startsWith: 'manualRate:' } }, orderBy: { key: 'asc' } });
    return rows.map((r) => ({ currency: r.key.slice('manualRate:'.length), scaled: BigInt(String(r.value)) }));
  }

  private async loadCbr(): Promise<{ rates: Map<string, bigint>; fetchedAt: Date } | null> {
    const fresh = this.cache && this.now().getTime() - this.cache.fetchedAt.getTime() < CACHE_TTL_MS;
    if (fresh) return this.cache;
    try {
      const rates = parseCbrXml(await this.fetchXml());
      if (rates.size === 0) throw new Error('empty CBR response');
      this.cache = { rates, fetchedAt: this.now() };
    } catch (e) {
      this.log.warn({ ...safeError(e) }, this.cache ? 'CBR fetch failed, using stale cache' : 'CBR fetch failed');
    }
    return this.cache;
  }
}

async function defaultFetchXml(): Promise<string> {
  const res = await fetch(CBR_URL, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`CBR HTTP ${res.status}`);
  return new TextDecoder('windows-1251').decode(await res.arrayBuffer());
}
