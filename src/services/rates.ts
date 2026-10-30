import type { Db } from '../db/client.js';
import type { Logger } from '../logger.js';
import { RATE_DECIMALS, RATE_SCALE, parseRate } from '../domain/pricing.js';
import { parseDecimalToMinor } from '../domain/money.js';
import { safeError } from '../logging/safe-error.js';
import {
  DEFAULT_THRESHOLDS,
  assessRate,
  changeBp,
  type RateThresholds,
  type RateWarning,
} from '../domain/rate-check.js';
import type { SettingsService } from './settings-service.js';

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

export interface RateAssessment {
  rate: RateInfo;
  warnings: RateWarning[];
}

/** Аномалия, найденная при обновлении курсов ЦБ (для оповещения админа). */
export interface RateAnomaly {
  currency: string;
  warning: Extract<RateWarning, { kind: 'jump' }>;
}

type Snapshot = { at: string; rates: Record<string, string> };

const SNAPSHOT_KEY = 'rateSeen';
const SNAPSHOT_MAX_AGE_MS = 72 * 3_600_000;
const jumpKey = (c: string) => `rateJump:${c}`;
const ackKey = (c: string) => `rateAck:${c}`;
const DEFAULT_CURRENCIES = ['USD', 'EUR', 'GBP'];

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
    private readonly settings?: Pick<SettingsService, 'getAll'>,
  ) {}

  private lastFailAt = 0;
  private onAnomaly: ((a: RateAnomaly) => void) | undefined;

  /** Подписка на резкие скачки курса (оповещение админа). */
  setAnomalyHandler(fn: (a: RateAnomaly) => void): void {
    this.onAnomaly = fn;
  }

  private async thresholds(): Promise<RateThresholds> {
    if (!this.settings) return DEFAULT_THRESHOLDS;
    const s = await this.settings.getAll();
    return { ...DEFAULT_THRESHOLDS, jumpBp: s.rateJumpBp, staleHours: s.rateStaleHours };
  }

  /**
   * Курс + предупреждения «до расчёта»: устаревший курс ЦБ, резкий скачок, давний или расходящийся с ЦБ ручной курс.
   * Недавнее осознанное подтверждение админа (`acknowledge`) гасит предупреждения по валюте на ackHours.
   */
  async assess(currency: string): Promise<RateAssessment> {
    const code = currency.toUpperCase();
    const rate = await this.getRate(code);
    if (code === 'RUB') return { rate, warnings: [] };
    const jumpRow = await this.db.setting.findUnique({ where: { key: jumpKey(code) } });
    const ackRow = await this.db.setting.findUnique({ where: { key: ackKey(code) } });
    const jv = jumpRow?.value as { from?: string; to?: string; at?: string } | null | undefined;
    const warnings = assessRate(
      {
        source: rate.source,
        scaled: rate.scaled,
        rateAt: rate.at,
        now: this.now(),
        jump:
          jv?.from && jv.to && jv.at
            ? { fromScaled: BigInt(jv.from), toScaled: BigInt(jv.to), at: new Date(jv.at) }
            : null,
        ackAt: ackRow && typeof ackRow.value === 'string' ? new Date(ackRow.value) : null,
        cbrScaled: rate.source === 'MANUAL' ? ((await this.loadCbr())?.rates.get(code) ?? null) : null,
      },
      await this.thresholds(),
    );
    return { rate, warnings };
  }

  /** Админ осознанно согласился считать по этому курсу: не переспрашиваем по валюте в течение часа. */
  async acknowledge(currency: string): Promise<void> {
    const key = ackKey(currency.toUpperCase());
    const value = this.now().toISOString();
    await this.db.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
  }

  /** Принудительное обновление кеша ЦБ (для планировщика: скачки и недоступность ЦБ замечаются без участия клиентов). */
  async refresh(): Promise<void> {
    await this.loadCbr();
  }

  /** Возраст последних известных курсов ЦБ, часы (null — данных нет). */
  async cbrAgeHours(): Promise<number | null> {
    const c = await this.loadCbr();
    return c ? (this.now().getTime() - c.fetchedAt.getTime()) / 3_600_000 : null;
  }

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
    await this.db.setting.upsert({
      where: { key },
      create: { key, value: scaled.toString() },
      update: { value: scaled.toString() },
    });
    return scaled;
  }

  async clearManual(currency: string): Promise<void> {
    await this.db.setting.deleteMany({ where: { key: manualKey(currency.toUpperCase()) } });
  }

  async listManual(): Promise<Array<{ currency: string; scaled: bigint }>> {
    const rows = await this.db.setting.findMany({
      where: { key: { startsWith: 'manualRate:' } },
      orderBy: { key: 'asc' },
    });
    return rows.map((r) => ({ currency: r.key.slice('manualRate:'.length), scaled: BigInt(String(r.value)) }));
  }

  private async loadCbr(): Promise<{ rates: Map<string, bigint>; fetchedAt: Date } | null> {
    const fresh = this.cache && this.now().getTime() - this.cache.fetchedAt.getTime() < CACHE_TTL_MS;
    if (fresh) return this.cache;
    // После неудачи не долбим ЦБ на каждый вызов: повтор не чаще раза в минуту.
    if (this.now().getTime() - this.lastFailAt < 60_000) return this.cache;
    try {
      const rates = parseCbrXml(await this.fetchXml());
      if (rates.size === 0) throw new Error('empty CBR response');
      this.cache = { rates, fetchedAt: this.now() };
      this.lastFailAt = 0;
      await this.recordSnapshot(rates).catch((e) => this.log.warn(safeError(e), 'rate snapshot failed'));
    } catch (e) {
      this.lastFailAt = this.now().getTime();
      this.log.warn({ ...safeError(e) }, this.cache ? 'CBR fetch failed, using stale cache' : 'CBR fetch failed');
      // После перезапуска при недоступном ЦБ берём последние сохранённые курсы (с их настоящим возрастом — это даст предупреждение «устарел»).
      if (!this.cache) this.cache = await this.loadSnapshot().catch(() => null);
    }
    return this.cache;
  }

  private async loadSnapshot(): Promise<{ rates: Map<string, bigint>; fetchedAt: Date } | null> {
    const row = await this.db.setting.findUnique({ where: { key: SNAPSHOT_KEY } });
    const snap = row?.value as Snapshot | null | undefined;
    if (!snap?.rates || !snap.at) return null;
    return { rates: new Map(Object.entries(snap.rates).map(([k, v]) => [k, BigInt(v)])), fetchedAt: new Date(snap.at) };
  }

  /** Сравнивает свежие курсы с прошлым снимком, помечает скачки, сохраняет новый снимок. */
  private async recordSnapshot(rates: Map<string, bigint>): Promise<void> {
    const now = this.now();
    const prev = await this.loadSnapshot();
    if (prev && now.getTime() - prev.fetchedAt.getTime() < SNAPSHOT_MAX_AGE_MS) {
      const th = await this.thresholds();
      const relevant = await this.relevantCurrencies();
      for (const [cur, scaled] of rates) {
        const before = prev.rates.get(cur);
        if (!before || changeBp(before, scaled) < th.jumpBp) continue;
        const key = jumpKey(cur);
        const value = { from: before.toString(), to: scaled.toString(), at: now.toISOString() };
        await this.db.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
        if (relevant.has(cur)) {
          this.onAnomaly?.({
            currency: cur,
            warning: {
              kind: 'jump',
              fromScaled: before,
              toScaled: scaled,
              changeBp: changeBp(before, scaled),
              at: now,
            },
          });
        }
      }
    }
    const value = {
      at: now.toISOString(),
      rates: Object.fromEntries([...rates].map(([k, v]) => [k, v.toString()])),
    } satisfies Snapshot;
    await this.db.setting.upsert({
      where: { key: SNAPSHOT_KEY },
      create: { key: SNAPSHOT_KEY, value },
      update: { value },
    });
  }

  /** Валюты, о которых стоит оповещать: основные + те, что встречались в заявках за 90 дней и в картах админа. */
  private async relevantCurrencies(): Promise<Set<string>> {
    const since = new Date(this.now().getTime() - 90 * 86_400_000);
    const [orders, cards] = await Promise.all([
      this.db.order.findMany({
        where: { createdAt: { gte: since }, currency: { not: null } },
        distinct: ['currency'],
        select: { currency: true },
      }),
      this.db.adminCard.findMany({ distinct: ['currency'], select: { currency: true } }),
    ]);
    return new Set([...DEFAULT_CURRENCIES, ...orders.map((o) => o.currency!), ...cards.map((c) => c.currency)]);
  }
}

async function defaultFetchXml(): Promise<string> {
  const res = await fetch(CBR_URL, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`CBR HTTP ${res.status}`);
  return new TextDecoder('windows-1251').decode(await res.arrayBuffer());
}
