import type { Deps } from './context.js';
import { formatRub } from '../domain/money.js';
import { balanceOf } from '../services/ledger-service.js';
import type { OrderWithClient, Settlement } from '../services/order-service.js';
import { balanceText } from '../texts/balance.js';
import { o as ot } from '../texts/orders.js';

/** Уведомление клиенту о выполнении заявки: разница по факту, баланс/долг и (для подарочных карт) код. */
export async function notifyOrderDone(
  deps: Pick<Deps, 'db' | 'notifier'>,
  order: OrderWithClient,
  settlement: Settlement,
  giftCode?: string,
): Promise<void> {
  const lines = [ot.doneNotice(order.id)];
  if (settlement.diffMinor > 0n) lines.push(ot.overpay(formatRub(settlement.diffMinor)));
  if (settlement.diffMinor < 0n) lines.push(ot.underpay(formatRub(settlement.diffMinor)));
  const balance = await balanceOf(deps.db, order.clientId);
  if (balance !== 0n) lines.push(balanceText(balance));
  if (order.payMode === 'PAY_LATER' && balance < 0n) lines.push(ot.debtAfterDone(formatRub(-balance)));
  await deps.notifier.toClient(order.client.telegramId, lines.join('\n'));
  if (giftCode) await deps.notifier.toClient(order.client.telegramId, ot.giftCodeMsg(order.id, giftCode));
}
