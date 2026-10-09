import type { LedgerEntry, Order, PaymentMethod, User } from '@prisma/client';
import { allowedTransitions, type Actor } from '../../domain/order-fsm.js';
import { formatRate } from '../../domain/pricing.js';
import { rateScaledOf } from '../../services/order-service.js';
import { LEDGER_LABEL } from '../../texts/balance.js';
import { STATUS_LABEL, TYPE_LABEL, o as ot } from '../../texts/orders.js';

/** Деньги наружу — строками в минимальных единицах (BigInt не сериализуется в JSON). */
const m = (x: bigint | null | undefined): string | null => (x == null ? null : x.toString());
const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export type ClientAction = 'confirm' | 'pay' | 'cancel' | 'requote' | 'new_link' | 'renew';
export type AdminAction = 'quote' | 'confirm_payment' | 'payment_not_found' | 'link_invalid' | 'complete' | 'reject';

/** Список доступных действий выводится из автомата статусов — UI не может предложить недопустимое. */
export function clientActions(o: Pick<Order, 'status' | 'payMode' | 'isSubscription'>): ClientAction[] {
  const out: ClientAction[] = [];
  for (const to of allowedTransitions(o, 'CLIENT')) {
    if (to === 'CANCELED') out.push('cancel');
    else if (to === 'PAYMENT_CHECK') out.push('pay');
    else if (to === 'QUOTED') out.push('requote');
    else if (to === 'AWAITING_PAYMENT' || (to === 'IN_PROGRESS' && o.status === 'QUOTED')) out.push('confirm');
    else if (to === 'IN_PROGRESS' && o.status === 'LINK_INVALID') out.push('new_link');
  }
  if (o.status === 'DONE' && o.isSubscription) out.push('renew');
  return [...new Set(out)];
}

export function adminActions(o: Pick<Order, 'status' | 'payMode'>): AdminAction[] {
  const out: AdminAction[] = [];
  for (const to of allowedTransitions(o, 'ADMIN')) {
    if (to === 'QUOTED') out.push('quote');
    else if (to === 'IN_PROGRESS' && o.status === 'PAYMENT_CHECK') out.push('confirm_payment');
    else if (to === 'AWAITING_PAYMENT') out.push('payment_not_found');
    else if (to === 'DONE') out.push('complete');
    else if (to === 'LINK_INVALID') out.push('link_invalid');
    else if (to === 'REJECTED') out.push('reject');
  }
  return [...new Set(out)];
}

export interface OrderDtoExtras {
  method?: Pick<PaymentMethod, 'title' | 'instructions' | 'requiresReceipt'> | null;
  trusted?: boolean | null;
  client?: User;
}

/** Код подарочной карты (даже зашифрованный) наружу не отдаётся никогда. */
export function orderDto(o: Order, role: Actor, extra: OrderDtoExtras = {}) {
  const dueMinor = o.payDueMinor ?? o.totalMinor;
  return {
    id: o.id,
    version: o.version,
    type: o.type,
    typeLabel: TYPE_LABEL[o.type],
    status: o.status,
    statusLabel: STATUS_LABEL[o.status],
    service: o.service,
    description: o.description,
    comment: o.comment,
    url: o.url,
    urlDomain: o.urlDomain,
    trusted: extra.trusted ?? null,
    giftRegion: o.giftRegion,
    amountMinor: m(o.amountMinor),
    currency: o.currency,
    isSubscription: o.isSubscription,
    periodKind: o.periodKind,
    periodDays: o.periodDays,
    nextChargeAt: iso(o.nextChargeAt),
    renewedFromId: o.renewedFromId,
    payMode: o.payMode,
    payModeLabel: ot.payModeShort[o.payMode],
    totalMinor: m(o.totalMinor),
    reservedMinor: m(o.reservedMinor),
    dueMinor: m(dueMinor),
    rate: o.rate && o.totalMinor != null ? formatRate(rateScaledOf(o)) : null,
    rateSource: o.rateSource,
    quoteExpiresAt: iso(o.quoteExpiresAt),
    diffMinor: m(o.diffMinor),
    rejectReason: o.rejectReason,
    createdAt: o.createdAt.toISOString(),
    actions: role === 'ADMIN' ? adminActions(o) : clientActions(o),
    payment:
      o.status === 'AWAITING_PAYMENT' && extra.method
        ? {
            method: extra.method.title,
            instructions: extra.method.instructions,
            requiresReceipt: extra.method.requiresReceipt,
            dueMinor: m(dueMinor),
          }
        : null,
    client: extra.client
      ? { id: extra.client.id, name: extra.client.displayName, username: extra.client.username }
      : null,
  };
}

export function ledgerDto(e: LedgerEntry) {
  return {
    id: e.id,
    type: e.type,
    label: LEDGER_LABEL[e.type],
    amountMinor: e.amountMinor.toString(),
    orderId: e.orderId,
    comment: e.comment,
    createdAt: e.createdAt.toISOString(),
  };
}
