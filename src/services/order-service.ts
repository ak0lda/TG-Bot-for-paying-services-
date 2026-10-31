import { Prisma } from '@prisma/client';
import type { Order, OrderStatus, OrderType, PayMode, PeriodKind, User } from '@prisma/client';
import type { Db } from '../db/client.js';
import { canTransition, InvalidTransitionError, type Actor } from '../domain/order-fsm.js';
import { availableOf, doneEntries, payLaterExposure, type LedgerInput } from '../domain/ledger.js';
import {
  computeQuote,
  convertToRubMinor,
  rateFromDecimalString,
  rateToDecimalString,
  settlementDiff,
} from '../domain/pricing.js';
import { addPeriod } from '../domain/period.js';
import { encrypt, type Keyring } from './crypto.js';
import { balanceOf, lockClient } from './ledger-service.js';
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
export class PayLaterDeniedError extends Error {}
/** Клиент пытается отметить оплату до того, как админ прислал реквизиты. */
export class RequisitesNotSentError extends Error {}
/** Реквизиты можно отправлять только пока заявка ждёт оплату. */
export class RequisitesNotAllowedError extends Error {}
/** Для подписки уже есть живая заявка-продление. */
export class RenewalExistsError extends Error {
  constructor(readonly order: Order) {
    super('renewal already exists');
  }
}
/** Превышен лимит «оплаты позже». */
export class PayLaterLimitError extends Error {
  constructor(
    readonly limitMinor: bigint,
    readonly exposureMinor: bigint,
  ) {
    super('pay-later limit exceeded');
  }
}

export interface NewOrderInput {
  clientId: number;
  type: OrderType;
  service: string;
  description?: string | null;
  url?: string | null;
  urlDomain?: string | null;
  linkRisk?: string | null;
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
  /** file_unique_id Telegram — по нему находим повторно присланные чеки. */
  uniqueId?: string | undefined;
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

interface Decision extends TransitionOpts {
  to: OrderStatus;
}

const RELEASING: readonly OrderStatus[] = ['EXPIRED', 'CANCELED', 'REJECTED'];

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
    private readonly keyring: Keyring,
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
          linkRisk: input.linkRisk ?? null,
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
        data: {
          orderId: order.id,
          actorId: input.clientId,
          fromStatus: null,
          toStatus: 'NEW',
          comment: 'Заявка создана',
        },
      });
      return order;
    });
  }

  // ── Переходы ──────────────────────────────────────────────
  /**
   * Единственное место, где меняется статус. Версия + право + допустимость проверяются в одной транзакции.
   * `decide` выполняется внутри транзакции и может читать/блокировать данные (баланс, лимиты) перед решением.
   * Резерв под заявку (BALANCE) автоматически возвращается при уходе в EXPIRED / CANCELED / REJECTED.
   */
  private async run(
    orderId: number,
    expectedVersion: number,
    actor: ActorRef,
    decide: (tx: Prisma.TransactionClient, order: Order) => Promise<Decision> | Decision,
  ): Promise<OrderWithClient> {
    await this.db.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) throw new OrderNotFoundError();
      if (order.version !== expectedVersion) throw new StaleOrderError(order);
      if (actor.role === 'CLIENT' && order.clientId !== actor.userId) throw new ForbiddenError();

      const d = await decide(tx, order);
      if (!canTransition(order, d.to, actor.role)) throw new InvalidTransitionError(order.status, d.to, actor.role);

      const patch: Prisma.OrderUncheckedUpdateManyInput = { ...d.patch };
      const ledger = [...(d.ledger ?? [])];
      if (order.reservedMinor > 0n && RELEASING.includes(d.to)) {
        ledger.push({ type: 'ORDER_RELEASE', amountMinor: order.reservedMinor, comment: 'Возврат резерва' });
        patch.reservedMinor = 0n;
      }

      const res = await tx.order.updateMany({
        where: { id: orderId, version: expectedVersion },
        data: { ...patch, status: d.to, version: { increment: 1 } },
      });
      if (res.count !== 1) throw new StaleOrderError(await tx.order.findUniqueOrThrow({ where: { id: orderId } }));

      await tx.orderEvent.create({
        data: { orderId, actorId: actor.userId, fromStatus: order.status, toStatus: d.to, comment: d.comment ?? null },
      });
      for (const e of ledger) {
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
      if (d.after) await d.after(tx, await tx.order.findUniqueOrThrow({ where: { id: orderId } }));
    });
    return this.getOrThrow(orderId);
  }

  private transition(
    orderId: number,
    expectedVersion: number,
    to: OrderStatus,
    actor: ActorRef,
    opts: TransitionOpts = {},
  ): Promise<OrderWithClient> {
    return this.run(orderId, expectedVersion, actor, () => ({ to, ...opts }));
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

  /**
   * Клиент подтвердил расчёт. Что происходит дальше зависит от режима оплаты:
   * - PREPAY: ждём перевод на весь итог;
   * - BALANCE: резервируем сколько есть на балансе; если хватает — сразу IN_PROGRESS, иначе ждём доплату переводом;
   * - PAY_LATER: проверяем лимит и сразу IN_PROGRESS (долг возникнет при выполнении).
   * Баланс и лимит проверяются под блокировкой строки клиента — параллельные заявки не «потратят» одни и те же деньги.
   * Если расчёт уже истёк — заявка переводится в EXPIRED.
   */
  async confirmQuote(
    orderId: number,
    version: number,
    clientId: number,
    payMethodId: number | null,
  ): Promise<{ expired: boolean; order: OrderWithClient }> {
    const o = await this.getOrThrow(orderId);
    if (o.version === version && o.quoteExpiresAt && o.quoteExpiresAt <= this.now()) {
      return {
        expired: true,
        order: await this.transition(orderId, version, 'EXPIRED', SYSTEM, { comment: 'Расчёт истёк' }),
      };
    }
    const order = await this.run(orderId, version, CLIENT(clientId), async (tx, cur) => {
      if (cur.totalMinor == null) throw new OrderDataError('order is not quoted');
      const total = cur.totalMinor;
      await lockClient(tx, cur.clientId);

      if (cur.payMode === 'PREPAY') {
        return {
          to: 'AWAITING_PAYMENT' as const,
          comment: 'Клиент подтвердил расчёт (перевод)',
          patch: { payMethodId, payDueMinor: total },
        };
      }

      if (cur.payMode === 'BALANCE') {
        const available = availableOf(await balanceOf(tx, cur.clientId));
        const reserve = available < total ? available : total;
        const ledger: LedgerInput[] =
          reserve > 0n
            ? [{ type: 'ORDER_RESERVE', amountMinor: -reserve, comment: `Резерв под заявку #${cur.id}` }]
            : [];
        if (reserve === total) {
          return {
            to: 'IN_PROGRESS' as const,
            comment: 'Клиент подтвердил расчёт (оплата с баланса)',
            patch: { reservedMinor: total, payDueMinor: 0n, paidAt: this.now() },
            ledger,
          };
        }
        return {
          to: 'AWAITING_PAYMENT' as const,
          comment: 'Клиент подтвердил расчёт (баланс + доплата переводом)',
          patch: { reservedMinor: reserve, payDueMinor: total - reserve, payMethodId },
          ledger,
        };
      }

      // PAY_LATER
      const user = await tx.user.findUniqueOrThrow({ where: { id: cur.clientId } });
      if (!user.payLaterEnabled) throw new PayLaterDeniedError();
      const open = await tx.order.aggregate({
        where: {
          clientId: cur.clientId,
          payMode: 'PAY_LATER',
          status: { in: ['IN_PROGRESS', 'LINK_INVALID'] },
          id: { not: cur.id },
        },
        _sum: { totalMinor: true },
      });
      const exposure = payLaterExposure(await balanceOf(tx, cur.clientId), open._sum.totalMinor ?? 0n, total);
      if (exposure > user.payLaterLimitMinor) throw new PayLaterLimitError(user.payLaterLimitMinor, exposure);
      return {
        to: 'IN_PROGRESS' as const,
        comment: 'Клиент подтвердил расчёт (оплата позже)',
        patch: { payDueMinor: 0n },
      };
    });
    return { expired: false, order };
  }

  markPaid(orderId: number, version: number, clientId: number, receipt?: Attached): Promise<OrderWithClient> {
    return this.run(orderId, version, CLIENT(clientId), (_tx, o) => {
      // Платить можно только по реквизитам, которые прислал админ (способ фиксируется в момент отправки).
      if (o.status === 'AWAITING_PAYMENT' && o.payMethodId == null) throw new RequisitesNotSentError();
      return {
        to: 'PAYMENT_CHECK' as const,
        comment: receipt ? 'Клиент отметил оплату, приложил чек' : 'Клиент отметил оплату',
        after: async (tx: Prisma.TransactionClient, order: Order) => {
          if (receipt) {
            await tx.attachment.create({
              data: {
                orderId: order.id,
                kind: 'RECEIPT',
                tgFileId: receipt.fileId,
                tgFileType: receipt.fileType,
                tgFileUniqueId: receipt.uniqueId ?? null,
                uploadedById: clientId,
              },
            });
          }
        },
      };
    });
  }

  /**
   * Админ выбрал способ перевода и отправил реквизиты (сам текст нигде не сохраняется).
   * Статус не меняется; в журнал событий пишется запись. Можно отправить повторно или выбрать другой способ.
   */
  async setPayMethod(
    orderId: number,
    version: number,
    adminId: number | null,
    methodId: number,
    title: string,
    auto = false,
  ): Promise<OrderWithClient> {
    await this.db.$transaction(async (tx) => {
      const o = await tx.order.findUnique({ where: { id: orderId } });
      if (!o) throw new OrderNotFoundError();
      if (o.version !== version) throw new StaleOrderError(o);
      if (o.status !== 'AWAITING_PAYMENT') throw new RequisitesNotAllowedError();
      await tx.order.update({ where: { id: orderId }, data: { payMethodId: methodId } });
      await tx.orderEvent.create({
        data: {
          orderId,
          actorId: adminId,
          fromStatus: o.status,
          toStatus: o.status,
          comment: `Реквизиты отправлены ${auto ? 'автоматически' : 'клиенту'}: ${title}`,
        },
      });
    });
    return this.getOrThrow(orderId);
  }

  /**
   * Админ подтвердил поступление перевода. Зачисляем его в журнал; для BALANCE докидываем сумму в резерв,
   * чтобы под заявку было зарезервировано ровно total.
   */
  async confirmPayment(orderId: number, version: number, adminId: number): Promise<OrderWithClient> {
    return this.run(orderId, version, ADMIN(adminId), (_tx, o) => {
      if (o.totalMinor == null) throw new OrderDataError('order is not quoted');
      // Подтверждать поступление до отправки реквизитов нельзя: способ и сумма к переводу ещё не определены.
      if (o.status === 'AWAITING_PAYMENT' && o.payMethodId == null) throw new RequisitesNotSentError();
      const due = o.payDueMinor ?? o.totalMinor;
      const ledger: LedgerInput[] = [
        { type: 'PAYMENT_RECEIVED', amountMinor: due, comment: `Оплата заявки #${orderId}` },
      ];
      const patch: Prisma.OrderUncheckedUpdateManyInput = { paidAt: this.now() };
      if (o.payMode === 'BALANCE') {
        ledger.push({ type: 'ORDER_RESERVE', amountMinor: -due, comment: `Резерв под заявку #${orderId}` });
        patch.reservedMinor = o.reservedMinor + due;
      }
      return { to: 'IN_PROGRESS' as const, comment: 'Оплата получена', patch, ledger };
    });
  }

  paymentNotFound(orderId: number, version: number, adminId: number): Promise<OrderWithClient> {
    return this.transition(orderId, version, 'AWAITING_PAYMENT', ADMIN(adminId), { comment: 'Оплата не найдена' });
  }

  markLinkInvalid(orderId: number, version: number, adminId: number): Promise<OrderWithClient> {
    return this.transition(orderId, version, 'LINK_INVALID', ADMIN(adminId), { comment: 'Ссылка не работает' });
  }

  submitNewLink(
    orderId: number,
    version: number,
    clientId: number,
    url: string,
    domain: string,
    linkRisk: string | null = null,
  ): Promise<OrderWithClient> {
    return this.transition(orderId, version, 'IN_PROGRESS', CLIENT(clientId), {
      comment: 'Клиент прислал новую ссылку',
      patch: { url, urlDomain: domain, linkRisk },
    });
  }

  reject(orderId: number, version: number, adminId: number, reason: string): Promise<OrderWithClient> {
    return this.transition(orderId, version, 'REJECTED', ADMIN(adminId), {
      comment: reason,
      patch: { rejectReason: reason },
    });
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
      reservedMinor: 0n,
    };
    if (o.type === 'GIFT_CARD' && input.giftCode) {
      patch.giftCodeEnc = new Uint8Array(encrypt(input.giftCode.trim(), this.keyring));
      patch.giftCodeDeleteAt = new Date(now.getTime() + settings.giftCodeRetentionDays * 86_400_000);
    }
    if (o.isSubscription && o.periodKind) patch.nextChargeAt = addPeriod(now, o.periodKind, o.periodDays);

    const order = await this.transition(orderId, version, 'DONE', ADMIN(adminId), {
      comment: 'Выполнено',
      patch,
      ledger: doneEntries(o.totalMinor, settlement.diffMinor, {
        reservedMinor: o.reservedMinor,
        payLater: o.payMode === 'PAY_LATER',
      }),
      after: async (tx, done) => {
        if (input.screenshot) {
          await tx.attachment.create({
            data: {
              orderId: done.id,
              kind: 'SCREENSHOT',
              tgFileId: input.screenshot.fileId,
              tgFileType: input.screenshot.fileType,
              tgFileUniqueId: input.screenshot.uniqueId ?? null,
              uploadedById: adminId,
            },
          });
        }
      },
    });
    return { order, settlement };
  }

  // ── Подписки ──────────────────────────────────────────────
  /**
   * Продление: новая заявка с теми же данными. Ссылку клиент присылает заново (старая одноразовая),
   * режим оплаты выбирается заново. Для одной подписки живая заявка-продление может быть только одна.
   */
  async renew(
    sourceId: number,
    clientId: number,
    over: { url: string | null; urlDomain: string | null; linkRisk?: string | null; payMode: PayMode },
  ): Promise<OrderWithClient> {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${sourceId} FOR UPDATE`;
      const src = await tx.order.findUnique({ where: { id: sourceId } });
      if (!src) throw new OrderNotFoundError();
      if (src.clientId !== clientId) throw new ForbiddenError();
      if (!src.isSubscription || src.status !== 'DONE' || src.amountMinor == null || !src.currency) {
        throw new OrderDataError('order is not a finished subscription');
      }
      const existing = await tx.order.findFirst({
        where: { renewedFromId: src.id, status: { notIn: ['CANCELED', 'REJECTED'] } },
      });
      if (existing) throw new RenewalExistsError(existing);

      const order = await tx.order.create({
        data: {
          clientId,
          type: src.type,
          service: src.service,
          description: src.description,
          url: over.url,
          urlDomain: over.urlDomain,
          linkRisk: over.linkRisk ?? null,
          giftStore: src.giftStore,
          giftRegion: src.giftRegion,
          amountMinor: src.amountMinor,
          currency: src.currency,
          isSubscription: true,
          periodKind: src.periodKind,
          periodDays: src.periodDays,
          comment: src.comment,
          payMode: over.payMode,
          renewedFromId: src.id,
        },
        include: { client: true },
      });
      await tx.orderEvent.create({
        data: {
          orderId: order.id,
          actorId: clientId,
          fromStatus: null,
          toStatus: 'NEW',
          comment: `Продление заявки #${src.id}`,
        },
      });
      return order;
    });
  }

  /**
   * Повтор уже закрытой заявки (выполнена не-подписка, отменена, отклонена): новая заявка с теми же данными.
   * Ссылку клиент присылает заново, режим оплаты выбирается заново. Подписки продлеваются через renew.
   */
  async reorder(
    sourceId: number,
    clientId: number,
    over: { url: string | null; urlDomain: string | null; linkRisk?: string | null; payMode: PayMode },
  ): Promise<OrderWithClient> {
    return this.db.$transaction(async (tx) => {
      const src = await tx.order.findUnique({ where: { id: sourceId } });
      if (!src) throw new OrderNotFoundError();
      if (src.clientId !== clientId) throw new ForbiddenError();
      const repeatable =
        (src.status === 'DONE' && !src.isSubscription) || src.status === 'CANCELED' || src.status === 'REJECTED';
      if (!repeatable || src.amountMinor == null || !src.currency) throw new OrderDataError('order cannot be repeated');
      const order = await tx.order.create({
        data: {
          clientId,
          type: src.type,
          service: src.service,
          description: src.description,
          url: over.url,
          urlDomain: over.urlDomain,
          linkRisk: over.linkRisk ?? null,
          giftStore: src.giftStore,
          giftRegion: src.giftRegion,
          amountMinor: src.amountMinor,
          currency: src.currency,
          isSubscription: src.isSubscription,
          periodKind: src.periodKind,
          periodDays: src.periodDays,
          comment: src.comment,
          payMode: over.payMode,
        },
        include: { client: true },
      });
      await tx.orderEvent.create({
        data: {
          orderId: order.id,
          actorId: clientId,
          fromStatus: null,
          toStatus: 'NEW',
          comment: `Повтор заявки #${src.id}`,
        },
      });
      return order;
    });
  }

  /** Клиент отказался продлевать: напоминания по этой заявке прекращаются. */
  async stopSubscription(sourceId: number, clientId: number): Promise<boolean> {
    const res = await this.db.order.updateMany({
      where: { id: sourceId, clientId, isSubscription: true, nextChargeAt: { not: null } },
      data: { nextChargeAt: null },
    });
    return res.count === 1;
  }

  /** Подписки с ближайшими списаниями (только выполненные и ещё не остановленные). */
  listSubscriptions(): Promise<OrderWithClient[]> {
    return this.db.order.findMany({
      where: { isSubscription: true, status: 'DONE', nextChargeAt: { not: null } },
      include: { client: true },
      orderBy: { nextChargeAt: 'asc' },
    });
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
