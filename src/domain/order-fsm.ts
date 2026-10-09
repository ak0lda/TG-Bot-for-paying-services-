import type { OrderStatus, PayMode } from '@prisma/client';

export type Actor = 'CLIENT' | 'ADMIN' | 'SYSTEM';

export interface FsmOrder {
  status: OrderStatus;
  payMode: PayMode;
}

interface Transition {
  from: OrderStatus;
  to: OrderStatus;
  actors: readonly Actor[];
  guard?: (o: FsmOrder) => boolean;
}

/** PREPAY — перевод на весь итог; BALANCE — перевод только на нехватку сверх баланса. */
const transfer = (o: FsmOrder) => o.payMode === 'PREPAY' || o.payMode === 'BALANCE';
const credit = (o: FsmOrder) => o.payMode === 'BALANCE' || o.payMode === 'PAY_LATER';

const T = (from: OrderStatus, to: OrderStatus, actors: Actor[], guard?: (o: FsmOrder) => boolean): Transition =>
  guard ? { from, to, actors, guard } : { from, to, actors };

const REJECTABLE: OrderStatus[] = ['NEW', 'QUOTED', 'AWAITING_PAYMENT', 'PAYMENT_CHECK', 'IN_PROGRESS', 'LINK_INVALID', 'EXPIRED'];
/** Клиент может отменить, пока оплата не подтверждена админом. */
const CANCELABLE: OrderStatus[] = ['NEW', 'QUOTED', 'AWAITING_PAYMENT', 'PAYMENT_CHECK', 'EXPIRED'];

export const TRANSITIONS: readonly Transition[] = [
  T('NEW', 'QUOTED', ['ADMIN']),
  T('EXPIRED', 'QUOTED', ['CLIENT', 'ADMIN']),
  T('QUOTED', 'AWAITING_PAYMENT', ['CLIENT'], transfer),
  T('QUOTED', 'IN_PROGRESS', ['CLIENT'], credit),
  T('QUOTED', 'EXPIRED', ['SYSTEM']),
  T('AWAITING_PAYMENT', 'PAYMENT_CHECK', ['CLIENT']),
  T('AWAITING_PAYMENT', 'EXPIRED', ['SYSTEM']),
  T('PAYMENT_CHECK', 'IN_PROGRESS', ['ADMIN']),
  T('PAYMENT_CHECK', 'AWAITING_PAYMENT', ['ADMIN']),
  T('IN_PROGRESS', 'DONE', ['ADMIN']),
  T('IN_PROGRESS', 'LINK_INVALID', ['ADMIN']),
  T('LINK_INVALID', 'IN_PROGRESS', ['CLIENT', 'ADMIN']),
  ...REJECTABLE.map((s) => T(s, 'REJECTED', ['ADMIN'])),
  ...CANCELABLE.map((s) => T(s, 'CANCELED', ['CLIENT'])),
];

export const FINAL_STATUSES: readonly OrderStatus[] = ['DONE', 'CANCELED', 'REJECTED'];

export const isFinal = (s: OrderStatus): boolean => FINAL_STATUSES.includes(s);

export function canTransition(order: FsmOrder, to: OrderStatus, actor: Actor): boolean {
  return TRANSITIONS.some(
    (t) => t.from === order.status && t.to === to && t.actors.includes(actor) && (!t.guard || t.guard(order)),
  );
}

export function allowedTransitions(order: FsmOrder, actor: Actor): OrderStatus[] {
  return TRANSITIONS.filter(
    (t) => t.from === order.status && t.actors.includes(actor) && (!t.guard || t.guard(order)),
  ).map((t) => t.to);
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: OrderStatus,
    readonly to: OrderStatus,
    readonly actor: Actor,
  ) {
    super(`Transition ${from} -> ${to} is not allowed for ${actor}`);
  }
}
