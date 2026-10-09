import { Prisma } from '@prisma/client';
import type { Order, OrderStatus, OrderType, PayMode, PeriodKind, User } from '@prisma/client';
import type { Db } from '../db/client.js';
import { canTransition, InvalidTransitionError, type Actor } from '../domain/order-fsm.js';
import { doneEntries, type LedgerInput } from '../domain/ledger.js';
import {
  computeQuote, convertToRubMinor, rateFromDecimalString, rateToDecimalString, settlementDiff,
} from '../domain/pricing.js';
import { addPeriod } from '../domain/period.js';
import { encrypt } from './crypto.js';
import type { RatesProvider } from './rates.js';
import type { SettingsService } from './settings-service.js';

export type OrderWithClient = Order & { client: User };

export interface ActorRef {
  role: Actor;
  userId: number | null;
}
export const ADMIN = (userId: number): ActorRef => ({ role: 'ADMIN', userId });
export const CLIENT = (userId: number): ActorRef => ({ role: 'CLIENT', userId });
export const SYSTEM: ActorRef = { role: 'SYSTEM', userId: null };

export class OrderNotFoundError extends Error {}
export class ForbiddenError extends Error {}
/** Версия заявки изменилась (двойной клик, устаревшая карточка). Несёт актуальное состояние. */
export class StaleOrderError extends Error {
  constructor(readonly order: Order) {
    super('stale order version');
  }
}
export class OrderDataError extends Error {}

export interface NewOrderInput {
  clientId: number;
  type: OrderType;
  service: string;
  description?: string | null;
  url?: string | null;
  urlDomain?: string | null;
  giftRegion?: string | null;
  amountMinor: bigint;
  currency: string;
  isSubscription: boolean;
  periodKind?: PeriodKind | null;
  periodDays?: number | null;
  comment?: string | null;
  payMode?: PayMode;
}

export interface Attached {
  fileId: string;
  fileType: 'photo' | 'document';
}

export interface CompleteInput {
  cardId: number;
  actualChargeMinor: bigint;
  /** Курс валюты карты к рублю (масштаб 1e8) — ЦБ или введён вручную. */
  cardRateScaled: bigint;
  giftCode?: string;
  screenshot?: Attached;
}

export interface Settlement {
  actualRubMinor: bigint;
  baseCostMinor: bigint;
  diffMinor: bigint;
}

interface TransitionOpts {
  comment?: string;
  patch?: Prisma.OrderUncheckedUpdateManyInput;
  ledger?: LedgerInput[];
  after?: (tx: Prisma.TransactionClient, order: Order) => Promise<void>;
}

export const rateScaledOf = (o: Pick<Order, 'rate'>): bigint => {
  if (!o.rate) throw new OrderDataError('order has no rate');
  return rateFromDecimalString(o.rate.toFixed(8));
};

/** Оценка себестоимости и разница по факту списания (без записи в БД). */
export function previewSettlement(
  order: Pick<Order, 'amountMinor' | 'rate' | 'fxBufferBp'>,
  actualChargeMinor: bigint,
  cardRateScaled: bigint,
): Settlement {
  if (order.amountMinor == null || order.fxBufferBp == null) throw new OrderDataError('order is not quoted');
  const { baseCostMinor } = computeQuote({
    amountMinor: order.amountMinor,
    rateScaled: rateScaledOf(order),
    fxBufferBp: order.fxBufferBp,
    markupBp: 0,
    fixedFeeMinor: 0n,
  });
  const actualRubMinor = convertToRubMinor(actualChargeMinor, cardRateScaled);
  return { actualRubMinor, baseCostMinor, diffMinor: settlementDiff(baseCostMinor, actualRubMinor) };
}

export class OrderService {
  constructor(
    private readonly db: Db,
    private readonly rates: RatesProvider,
    private readonly settings: Pick<SettingsService, 'getAll'>,
    private readonly encryptionKey: Buffer,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ── Чтение ────────────────────────────────────────────────
  async get(id: number): Promise<OrderWithClient | null> {
    return this.db.order.findUnique({ where: { id }, include: { client: true } });
  }
  async getOrThrow(id: number): Promise<OrderWithClient> {
    const o = await this.get(id);
    if (!o) throw new OrderNotFoundError();
    return o;
  }
  listForClient(clientId: number, take = 10): Promise<Order[]> {
    return this.db.order.findMany({ where: { clientId }, orderBy: { id: 'desc' }, take });
  }
  listOpen(): Promise<OrderWithClient[]> {
    return this.db.order.findMany({
      where: { status: { notIn: ['DONE', 'CANCELED', 'REJECTED'] } },
      include: { client: true },
      orderBy: { id: 'asc' },
    });
  }

  // ── Создание ──────────────────────────────────────────────
  async create(input: NewOrderInput): Promise<OrderWithClient> {
    return this.db.$transaction(async (tx) => {
      const order = await tx.order.create({
        data: {
          clientId: input.clientId,
          type: input.type,
          service: input.service,
          description: input.description ?? null,
          url: input.url ?? null,
          urlDomain: input.urlDomain ?? null,
          giftStore: input.type === 'GIFT_CARD' ? input.service : null,
          giftRegion: input.giftRegion ?? null,
          amountMinor: input.amountMinor,
          currency: input.currency,
          isSubscription: input.isSubscription,
          periodKind: input.isSubscription ? (input.periodKind ?? null) : null,
          periodDays: input.isSubscription ? (input.periodDays ?? null) : null,
          comment: input.comment ?? null,
          payMode: input.payMode ?? 'PREPAY',
        },
        include: { client: true },
      });
      await tx.orderEvent.create({
        data: { orderId: order.id, actorId: input.clientId, fromStatus: null, toStatus: 'NEW', comment: 'Заявка создана' },
      });
      return order;
    });
  }

  // ── Переходы ──────────────────────────────────────────────
  /** Единственное место, где меняется статус. Версия + право + допустимость проверяются в одной транзакции. */
  private async transition(
    orderId: number,
    expectedVersion: number,
    to: OrderStatus,
    actor: ActorRef,
    opts: TransitionOpts = {},
  ): Promise<OrderWithClient> {
    await this.db.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) throw new OrderNotFoundError();
      if (order.version !== expectedVersion) throw new StaleOrderError(order);
      if (actor.role === 'CLIENT' && order.clientId !== actor.userId) throw new ForbiddenError();
      if (!canTransition(order, to, actor.role)) throw new InvalidTransitionError(order.status, to, actor.role);

      const res = await tx.order.updateMany({
        where: { id: orderId, version: expectedVersion },
        data: { ...opts.patch, status: to, version: { increment: 1 } },
      });
      if (res.count !== 1) throw new StaleOrderError((await tx.order.findUniqueOrThrow({ where: { id: orderId } })));

      await tx.orderEvent.create({
        data: { orderId, actorId: actor.userId, fromStatus: order.status, toStatus: to, comment: opts.comment ?? null },
      });
      for (const e of opts.ledger ?? []) {
        await tx.ledgerEntry.create({
          data: {
            clientId: order.clientId,
            orderId,
            type: e.type,
            amountMinor: e.amountMinor,
            comment: e.comment ?? null,
            createdById: actor.userId,
          },
        });
      }
      if (opts.after) await opts.after(tx, await tx.order.findUniqueOrThrow({ where: { id: orderId } }));
    });
    return this.getOrThrow(orderId);
  }

  /** NEW | EXPIRED -> QUOTED. Курс — ручной (если задан) или ЦБ; параметры расчёта фиксируются в заявке. */
  async quote(orderId: number, version: number, actor: ActorRef): Promise<OrderWithClient> {
    const o = await this.getOrThrow(orderId);
    if (o.amountMinor == null || !o.currency) throw new OrderDataError('order has no amount');
    const rate = await this.rates.getRate(o.currency);
    const s = await this.settings.getAll();
    const q = computeQuote({
      amountMinor: o.amountMinor,
      rateScaled: rate.scaled,
      fxBufferBp: s.fxBufferBp,
      markupBp: s.markupBp,
      fixedFeeMinor: BigInt(s.fixedFeeMinor),
    });
    const now = this.now();
    return this.transition(orderId, version, 'QUOTED', actor, {
      comment: `Расчёт: ${q.totalMinor / 100n} ₽`,
      patch: {
        rate: new Prisma.Decimal(rateToDecimalString(rate.scaled)),
        rateSource: rate.source,
        rateAt: rate.at,
        fxBufferBp: s.fxBufferBp,
        markupBp: s.markupBp,
        fixedFeeMinor: BigInt(s.fixedFeeMinor),
        totalMinor: q.totalMinor,
        quotedAt: now,
        quoteExpiresAt: new Date(now.getTime() + s.quoteTtlHours * 3_600_000),
      },
    });
  }

  /** Клиент подтвердил расчёт. Если расчёт уже истёк — заявка переводится в EXPIRED. */
  async confirmQuote(
    orderId: number,
    version: number,
    clientId: number,
    payMethodId: number | null,
  ): Promise<{ expired: boolean; order: OrderWithClient }> {
    const o = await this.getOrThrow(orderId);
    if (o.version === version && o.quoteExpiresAt && o.quoteExpiresAt <= this.now()) {
      return { expired: true, order: await this.transition(orderId, version, 'EXPIRED', SYSTEM, { comment: 'Расчёт истёк' }) };
    }
    const order = await this.transition(orderId, version, 'AWAITING_PAYMENT', CLIENT(clientId), {
      comment: 'Клиент подтвердил расчёт',
      patch: { payMethodId },
    });
    return { expired: false, order };
  }

  markPaid(orderId: number, version: number, clientId: number, receipt?: Attached): Promise<OrderWithClient> {
    return this.transition(orderId, version, 'PAYMENT_CHECK', CLIENT(clientId), {
      comment: receipt ? 'Клиент отметил оплату, приложил чек' : 'Клиент отметил оплату',
      after: async (tx, order) => {
        if (receipt) {
          await tx.attachment.create({
            data: { orderId: order.id, kind: 'RECEIPT', tgFileId: receipt.fileId, tgFileType: receipt.fileType, uploadedById: clientId },
          });
        }
      },
    });
  }

  async confirmPayment(orderId: number, version: number, adminId: number): Promise<OrderWithClient> {
    const o = await this.getOrThrow(orderId);
    if (o.totalMinor == null) throw new OrderDataError('order is not quoted');
    return this.transition(orderId, version, 'IN_PROGRESS', ADMIN(adminId), {
      comment: 'Оплата получена',
      patch: { paidAt: this.now() },
      ledger: [{ type: 'PAYMENT_RECEIVED', amountMinor: o.totalMinor, comment: `Оплата заявки #${orderId}` }],
    });
  }

  paymentNotFound(orderId: number, version: number, adminId: number): Promise<OrderWithClient> {
    return this.transition(orderId, version, 'AWAITING_PAYMENT', ADMIN(adminId), { comment: 'Оплата не найдена' });
  }

  markLinkInvalid(orderId: number, version: number, adminId: number): Promise<OrderWithClient> {
    return this.transition(orderId, version, 'LINK_INVALID', ADMIN(adminId), { comment: 'Ссылка не работает' });
  }

  submitNewLink(orderId: number, version: number, clientId: number, url: string, domain: string): Promise<OrderWithClient> {
    return this.transition(orderId, version, 'IN_PROGRESS', CLIENT(clientId), {
      comment: 'Клиент прислал новую ссылку',
      patch: { url, urlDomain: domain },
    });
  }

  reject(orderId: number, version: number, adminId: number, reason: string): Promise<OrderWithClient> {
    return this.transition(orderId, version, 'REJECTED', ADMIN(adminId), { comment: reason, patch: { rejectReason: reason } });
  }

  cancel(orderId: number, version: number, clientId: number): Promise<OrderWithClient> {
    return this.transition(orderId, version, 'CANCELED', CLIENT(clientId), { comment: 'Отменено клиентом' });
  }

  /** После пересчёта EXPIRED -> QUOTED. */
  requote(orderId: number, version: number, actor: ActorRef): Promise<OrderWithClient> {
    return this.quote(orderId, version, actor);
  }

  /** IN_PROGRESS -> DONE: фиксируем факт, пишем проводки (списание по расчёту + разница), шифруем код. */
  async complete(
    orderId: number,
    version: number,
    adminId: number,
    input: CompleteInput,
  ): Promise<{ order: OrderWithClient; settlement: Settlement }> {
    const o = await this.getOrThrow(orderId);
    if (o.totalMinor == null) throw new OrderDataError('order is not quoted');
    if (input.actualChargeMinor <= 0n) throw new OrderDataError('bad actual charge');
    const card = await this.db.adminCard.findUnique({ where: { id: input.cardId } });
    if (!card) throw new OrderDataError('card not found');
    if (o.type === 'GIFT_CARD' && !input.giftCode?.trim()) throw new OrderDataError('gift code required');

    const settlement = previewSettlement(o, input.actualChargeMinor, input.cardRateScaled);
    const settings = await this.settings.getAll();
    const now = this.now();

    const patch: Prisma.OrderUncheckedUpdateManyInput = {
      actualChargeMinor: input.actualChargeMinor,
      actualCurrency: card.currency,
      cardId: card.id,
      diffMinor: settlement.diffMinor,
    };
    if (o.type === 'GIFT_CARD' && input.giftCode) {
      patch.giftCodeEnc = new Uint8Array(encrypt(input.giftCode.trim(), this.encryptionKey));
      patch.giftCodeDeleteAt = new Date(now.getTime() + settings.giftCodeRetentionDays * 86_400_000);
    }
    if (o.isSubscription && o.periodKind) patch.nextChargeAt = addPeriod(now, o.periodKind, o.periodDays);

    const order = await this.transition(orderId, version, 'DONE', ADMIN(adminId), {
      comment: 'Выполнено',
      patch,
      ledger: doneEntries(o.totalMinor, settlement.diffMinor),
      after: async (tx, done) => {
        if (input.screenshot) {
          await tx.attachment.create({
            data: {
              orderId: done.id, kind: 'SCREENSHOT', tgFileId: input.screenshot.fileId,
              tgFileType: input.screenshot.fileType, uploadedById: adminId,
            },
          });
        }
      },
    });
    return { order, settlement };
  }

  // ── Истечение расчётов ────────────────────────────────────
  /** QUOTED / AWAITING_PAYMENT с истёкшим сроком -> EXPIRED. Возвращает затронутые заявки для уведомлений. */
  async expireDue(): Promise<OrderWithClient[]> {
    const due = await this.db.order.findMany({
      where: { status: { in: ['QUOTED', 'AWAITING_PAYMENT'] }, quoteExpiresAt: { lte: this.now() } },
    });
    const expired: OrderWithClient[] = [];
    for (const o of due) {
      try {
        expired.push(await this.transition(o.id, o.version, 'EXPIRED', SYSTEM, { comment: 'Расчёт истёк' }));
      } catch (e) {
        if (!(e instanceof StaleOrderError)) throw e; // кто-то успел изменить заявку — пропускаем
      }
    }
    return expired;
  }
}
