import { InlineKeyboard } from 'grammy';
import type { PaymentMethod } from '@prisma/client';
import type { Deps } from './context.js';
import { debtOf } from '../domain/ledger.js';
import { formatRub } from '../domain/money.js';
import { balanceOf } from '../services/ledger-service.js';
import type { OrderWithClient } from '../services/order-service.js';
import type { TopUpWithClient } from '../services/topup-service.js';
import { b } from '../texts/balance.js';
import { cx } from '../texts/crypto.js';
import { o as ot } from '../texts/orders.js';

// Реквизиты присылает админ вручную для каждой заявки/пополнения. Текст только пересылается клиенту:
// в БД, журналах и событиях он не сохраняется (в журнал пишется лишь «реквизиты отправлены: способ»).

/** Карточка пополнения для админа: способы (кнопки «отправить реквизиты») + подтверждение/отказ. */
export async function topUpAdminCard(
  deps: Pick<Deps, 'db' | 'topups' | 'catalog' | 'config'>,
  topUp: TopUpWithClient,
): Promise<{ text: string; kb: InlineKeyboard }> {
  const debt = debtOf(await balanceOf(deps.db, topUp.clientId));
  if (topUp.kind === 'USDT_TRC20') {
    const kb = new InlineKeyboard();
    if (topUp.cryptoTxId) kb.url(cx.tronscanBtn, `https://tronscan.org/#/transaction/${topUp.cryptoTxId}`).row();
    kb.text(b.confirmTopUp, `t:${topUp.id}:ok`).row().text(b.rejectTopUp, `t:${topUp.id}:no`);
    return {
      text: cx.adminCard({
        id: topUp.id,
        client: topUp.client,
        amountMicro: topUp.cryptoAmountMicro ?? 0n,
        creditMinor: topUp.amountMinor,
        txid: topUp.cryptoTxId,
        expires: topUp.expiresAt
          ? new Intl.DateTimeFormat('ru-RU', {
              timeZone: deps.config.TIMEZONE,
              day: '2-digit',
              month: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
            }).format(topUp.expiresAt)
          : '—',
        debt,
      }),
      kb,
    };
  }
  const receipts = await deps.topups.receiptCount(topUp.id);
  const kb = new InlineKeyboard();
  for (const m of await deps.catalog.listMethods(true))
    kb.text(ot.requisitesBtn(m.title), `p:${topUp.id}:${m.id}`).row();
  kb.text(b.confirmTopUp, `t:${topUp.id}:ok`).row().text(b.rejectTopUp, `t:${topUp.id}:no`);
  return {
    text: b.adminTopUp({
      id: topUp.id,
      client: topUp.client,
      amount: topUp.amountMinor,
      method: topUp.method?.title ?? null,
      receipts,
      debt,
    }),
    kb,
  };
}

export async function notifyAdminTopUp(deps: Deps, topUp: TopUpWithClient, intro?: string): Promise<void> {
  const card = await topUpAdminCard(deps, topUp);
  await deps.notifier.toAdmin(intro ? `${intro}\n\n${card.text}` : card.text, card.kb);
}

/** Реквизиты по заявке -> клиенту, с кнопками заявки («Я оплатил», «Отменить»). */
export async function deliverOrderRequisites(
  deps: Deps,
  order: OrderWithClient,
  method: PaymentMethod,
  text: string,
): Promise<void> {
  const due = order.payDueMinor ?? order.totalMinor ?? 0n;
  const view = await deps.presenter.client(order);
  await deps.notifier.toClient(
    order.client.telegramId,
    ot.requisitesMsg(formatRub(due), method.title, text, method.requiresReceipt),
    view.keyboard,
  );
}

/** Реквизиты по пополнению -> клиенту, с кнопкой «Отправить чек» (если способ требует чек). */
export async function deliverTopUpRequisites(
  deps: Deps,
  topUp: TopUpWithClient,
  method: PaymentMethod,
  text: string,
): Promise<void> {
  const kb = method.requiresReceipt ? new InlineKeyboard().text(b.sendReceiptBtn, `b:rc:${topUp.id}`) : undefined;
  await deps.notifier.toClient(
    topUp.client.telegramId,
    b.topUpRequisitesMsg(topUp.id, topUp.amountMinor, method.title, text, method.requiresReceipt),
    kb,
  );
}
