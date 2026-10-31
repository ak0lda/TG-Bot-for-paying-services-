import { formatRub } from '../domain/money.js';
import type { Obligation } from '../services/payment-matcher.js';
import { escapeHtml } from './ru.js';
import { formatAgeShort } from './age.js';

export const bank = {
  hint: 'Пересылай мне уведомления банка о поступлении — найду заявку и предложу подтвердить.',
  outgoing: 'Похоже на списание, а не на поступление — пропускаю.',
  nonRub: (list: string) => `В уведомлении сумма не в рублях (${escapeHtml(list)}) — сверь с заявками вручную.`,
  directionUnknown: ' (направление операции не распознал — проверь, что это поступление)',
  matchOne: (amount: bigint, o: Obligation, unknownDir: boolean) =>
    `💰 В уведомлении: <b>${formatRub(amount)}</b>${unknownDir ? bank.directionUnknown : ''}\nПохоже на: ${escapeHtml(o.title)}, клиент #${o.clientId} ${escapeHtml(o.clientName)}\nПодтвердить поступление?`,
  matchMany: (amount: bigint, list: Obligation[], unknownDir: boolean) =>
    `💰 В уведомлении: <b>${formatRub(amount)}</b>${unknownDir ? bank.directionUnknown : ''}\nПодходит несколько — выбери, что именно пришло:\n${list
      .map(
        (o) =>
          `• ${escapeHtml(o.title)}, клиент #${o.clientId} ${escapeHtml(o.clientName)} (${formatAgeShort(o.createdAt)})`,
      )
      .join('\n')}`,
  noMatch: (amount: bigint, open: Obligation[]) =>
    `💰 В уведомлении: <b>${formatRub(amount)}</b> — заявки или пополнения на точно такую сумму не нашёл.${
      open.length
        ? `\nЖдут оплату:\n${open
            .slice(0, 6)
            .map(
              (o) =>
                `• ${escapeHtml(o.title)} — ${formatRub(o.amountMinor)}, ${escapeHtml(o.clientName)} (${formatAgeShort(o.createdAt)})`,
            )
            .join('\n')}\nЕсли клиент перевёл другую сумму, подтверди нужную заявку вручную: /orders`
        : '\nСейчас никто не ждёт оплату.'
    }`,
  confirmBtn: (o: Obligation) => `✅ Подтвердить: ${o.kind === 'order' ? 'заявка' : 'пополнение'} #${o.id}`,
  confirmed: (id: number) => `✅ Поступление подтверждено — заявка #${id} в работе.`,
  stale: 'Заявка уже изменилась — открой её заново: /orders',
};
