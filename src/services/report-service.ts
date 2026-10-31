import type { OrderStatus } from '@prisma/client';
import type { Db } from '../db/client.js';
import { csvCellsHeaderLedger, csvCellsHeaderOrders } from './report-columns.js';
import { moneyCell, text, toCsv } from '../domain/csv.js';
import type { DateRange } from '../domain/range.js';
import { computeQuote } from '../domain/pricing.js';
import { buildStats, type DoneOrder, type Stats } from '../domain/stats.js';
import { adviseFxBuffer, slipBp, type FxSample } from '../domain/fx-advice.js';
import { SETTING_DEFS } from '../domain/settings.js';
import { rateScaledOf } from './order-service.js';

export interface StatsReport {
  stats: Stats;
  createdByStatus: Partial<Record<OrderStatus, number>>;
  topUpMinor: bigint;
  repaidMinor: bigint;
}

const DEFAULT_FX_BUFFER_BP = SETTING_DEFS.fxBufferBp.default;

const between = (range: DateRange) => ({
  ...(range.from ? { gte: range.from } : {}),
  ...(range.to ? { lt: range.to } : {}),
});

export class ReportService {
  constructor(private readonly db: Db) {}

  /** Статистика по выполненным заявкам: период определяется моментом перехода в DONE. */
  async stats(range: DateRange): Promise<StatsReport> {
    const events = await this.db.orderEvent.findMany({
      where: { toStatus: 'DONE', createdAt: between(range) },
      select: { orderId: true },
    });
    const orders = await this.db.order.findMany({
      where: { id: { in: events.map((e) => e.orderId) }, status: 'DONE' },
      include: { client: true, card: true },
    });

    const done: DoneOrder[] = orders.map((o) => {
      const base = computeQuote({
        amountMinor: o.amountMinor!,
        rateScaled: rateScaledOf(o),
        fxBufferBp: o.fxBufferBp ?? 0,
        markupBp: 0,
        fixedFeeMinor: 0n,
      }).baseCostMinor;
      return {
        clientId: o.clientId,
        clientName: o.client.displayName,
        service: o.service,
        totalMinor: o.totalMinor!,
        costMinor: base - (o.diffMinor ?? 0n),
        cardLabel: o.card?.label ?? '—',
        cardCurrency: o.actualCurrency ?? o.card?.currency ?? '—',
        chargeInCardCurrencyMinor: o.actualChargeMinor ?? 0n,
      };
    });

    const created = await this.db.order.groupBy({
      by: ['status'],
      where: { createdAt: between(range) },
      _count: { _all: true },
    });
    const ledger = await this.db.ledgerEntry.groupBy({
      by: ['type'],
      where: { type: { in: ['TOPUP', 'DEBT_REPAY'] }, createdAt: between(range) },
      _sum: { amountMinor: true },
    });
    const sum = (t: string) => ledger.find((l) => l.type === t)?._sum.amountMinor ?? 0n;

    return {
      stats: buildStats(done),
      createdByStatus: Object.fromEntries(created.map((c) => [c.status, c._count._all])),
      topUpMinor: sum('TOPUP'),
      repaidMinor: sum('DEBT_REPAY'),
    };
  }

  /**
   * Проскальзывание конвертации по выполненным заявкам за последние `days` дней:
   * фактический расход в ₽ против чистой конвертации по курсу расчёта (без запаса и наценки).
   */
  async fxSamples(days: number, now: Date = new Date()): Promise<Array<FxSample & { currency: string }>> {
    const since = new Date(now.getTime() - days * 86_400_000);
    const events = await this.db.orderEvent.findMany({
      where: { toStatus: 'DONE', createdAt: { gte: since } },
      select: { orderId: true },
    });
    const orders = await this.db.order.findMany({
      where: { id: { in: events.map((e) => e.orderId) }, status: 'DONE', rate: { not: null } },
    });
    const out: Array<FxSample & { currency: string }> = [];
    for (const o of orders) {
      if (o.amountMinor == null || o.diffMinor == null) continue;
      const rateScaled = rateScaledOf(o);
      const quote = (fxBufferBp: number) =>
        computeQuote({ amountMinor: o.amountMinor!, rateScaled, fxBufferBp, markupBp: 0, fixedFeeMinor: 0n })
          .baseCostMinor;
      const actual = quote(o.fxBufferBp ?? 0) - o.diffMinor; // расход = оценка с запасом − разница по факту
      out.push({ slipBp: slipBp(actual, quote(0)), currency: o.actualCurrency ?? '—' });
    }
    return out;
  }

  /** Рекомендация по запасу на конвертацию: общая и по валюте карты. */
  async fxAdvice(days: number, currentBp?: number, now: Date = new Date()) {
    const samples = await this.fxSamples(days, now);
    const current = currentBp ?? (await this.currentFxBufferBp());
    const overall = adviseFxBuffer(samples, current);
    const groups = new Map<string, FxSample[]>();
    for (const s of samples) groups.set(s.currency, [...(groups.get(s.currency) ?? []), s]);
    const byCurrency = [...groups]
      .map(([currency, xs]) => {
        const a = adviseFxBuffer(xs, current);
        return { currency, sample: a.sample, medianBp: a.medianBp, p90Bp: a.p90Bp };
      })
      .sort((a, b) => b.sample - a.sample);
    return { overall, byCurrency };
  }

  private async currentFxBufferBp(): Promise<number> {
    const row = await this.db.setting.findUnique({ where: { key: 'fxBufferBp' } });
    return typeof row?.value === 'number' ? row.value : DEFAULT_FX_BUFFER_BP;
  }

  /** CSV заявок за период (по дате создания). Без ссылок целиком (только домен) и без кодов подарочных карт. */
  async ordersCsv(range: DateRange): Promise<{ csv: string; rows: number }> {
    const orders = await this.db.order.findMany({
      where: { createdAt: between(range) },
      include: { client: true, card: true },
      orderBy: { id: 'asc' },
    });
    const doneAt = new Map<number, Date>();
    if (orders.length) {
      const events = await this.db.orderEvent.findMany({
        where: { orderId: { in: orders.map((o) => o.id) }, toStatus: 'DONE' },
      });
      for (const e of events) doneAt.set(e.orderId, e.createdAt);
    }
    const rows = orders.map((o) => [
      o.id,
      o.createdAt,
      o.status,
      o.type,
      o.clientId,
      text(o.client.displayName),
      text(o.service),
      text(o.description),
      o.urlDomain,
      moneyCell(o.amountMinor),
      o.currency,
      o.isSubscription,
      o.payMode,
      o.rate?.toFixed(8) ?? null,
      moneyCell(o.totalMinor),
      text(o.card?.label),
      moneyCell(o.actualChargeMinor),
      o.actualCurrency,
      moneyCell(o.diffMinor),
      doneAt.get(o.id) ?? null,
      text(o.rejectReason),
      text(o.comment),
    ]);
    return { csv: toCsv(csvCellsHeaderOrders, rows), rows: rows.length };
  }

  /** CSV операций баланса за период. */
  async ledgerCsv(range: DateRange): Promise<{ csv: string; rows: number }> {
    const entries = await this.db.ledgerEntry.findMany({
      where: { createdAt: between(range) },
      include: { client: true },
      orderBy: { id: 'asc' },
    });
    const rows = entries.map((e) => [
      e.id,
      e.createdAt,
      e.clientId,
      text(e.client.displayName),
      e.type,
      moneyCell(e.amountMinor),
      e.orderId,
      e.topUpId,
      text(e.comment),
    ]);
    return { csv: toCsv(csvCellsHeaderLedger, rows), rows: rows.length };
  }
}
