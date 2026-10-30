import type { PaymentMethod } from '@prisma/client';
import type { Deps } from './context.js';
import { deliverOrderRequisites, deliverTopUpRequisites } from './requisites.js';
import { pickAutoMethod } from '../domain/auto-requisites.js';
import { RequisitesNotAllowedError, StaleOrderError, type OrderWithClient } from '../services/order-service.js';
import { TopUpNotPendingError, type TopUpWithClient } from '../services/topup-service.js';

export type AutoOrderResult =
  { sent: true; order: OrderWithClient; method: PaymentMethod } | { sent: false; hadCandidates: boolean };

export type AutoTopUpResult =
  { sent: true; topUp: TopUpWithClient; method: PaymentMethod } | { sent: false; hadCandidates: boolean };

/**
 * Автоотправка реквизитов по заявке (она только что перешла в AWAITING_PAYMENT): сервер сам выбирает способ по сумме к переводу
 * и присылает клиенту готовый текст способа. Если способ не нашёлся — вызывающий код идёт обычным путём (админ присылает вручную).
 */
export async function autoSendOrderRequisites(deps: Deps, order: OrderWithClient): Promise<AutoOrderResult> {
  const amount = order.payDueMinor ?? order.totalMinor ?? 0n;
  const pick = pickAutoMethod(await deps.catalog.listMethods(true), amount);
  if (!pick.method || amount <= 0n) return { sent: false, hadCandidates: pick.hadCandidates };
  try {
    const updated = await deps.orders.setPayMethod(
      order.id,
      order.version,
      null,
      pick.method.id,
      pick.method.title,
      true,
    );
    await deliverOrderRequisites(deps, updated, pick.method, pick.method.instructions);
    deps.log.info({ orderId: order.id, methodId: pick.method.id }, 'requisites sent automatically');
    return { sent: true, order: updated, method: pick.method };
  } catch (e) {
    // Заявку успели изменить (отмена, повторное нажатие) — просто не отправляем.
    if (e instanceof StaleOrderError || e instanceof RequisitesNotAllowedError)
      return { sent: false, hadCandidates: pick.hadCandidates };
    throw e;
  }
}

/** То же для пополнения баланса. */
export async function autoSendTopUpRequisites(deps: Deps, topUp: TopUpWithClient): Promise<AutoTopUpResult> {
  const pick = pickAutoMethod(await deps.catalog.listMethods(true), topUp.amountMinor);
  if (!pick.method) return { sent: false, hadCandidates: pick.hadCandidates };
  try {
    const updated = await deps.topups.setMethod(topUp.id, pick.method.id);
    await deliverTopUpRequisites(deps, updated, pick.method, pick.method.instructions);
    deps.log.info({ topUpId: topUp.id, methodId: pick.method.id }, 'top-up requisites sent automatically');
    return { sent: true, topUp: updated, method: pick.method };
  } catch (e) {
    if (e instanceof TopUpNotPendingError) return { sent: false, hadCandidates: pick.hadCandidates };
    throw e;
  }
}
