import type { OrderStatus } from '@prisma/client';
import type { Db } from '../db/client.js';
import { csvCellsHeaderLedger, csvCellsHeaderOrders } from './report-columns.js';
import { moneyCell, text, toCsv } from '../domain/csv.js';
import type { DateRange } from '../domain/range.js';
import { computeQuote } from '../domain/pricing.js';
import { buildStats, type DoneOrder, type Stats } from '../domain/stats.js';
import { rateScaledOf } from './order-service.js';

export interface StatsReport {
  stats: Stats;
  createdByStatus: Partial<Record<OrderStatus, number>>;
  topUpMinor: bigint;
  repaidMinor: bigint;
}

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
