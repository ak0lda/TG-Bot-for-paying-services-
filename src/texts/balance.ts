import type { LedgerEntry, LedgerType, PaymentMethod, User } from '@prisma/client';
import { formatMinor, formatRub } from '../domain/money.js';
import { escapeHtml } from './ru.js';

export const LEDGER_LABEL: Record<LedgerType, string> = {
  TOPUP: 'Пополнение',
  ORDER_RESERVE: 'Резерв под заявку',
  ORDER_RELEASE: 'Возврат резерва',
  ORDER_CHARGE: 'Списание по заявке',
  PAYMENT_RECEIVED: 'Оплата заявки переводом',
  DIFF_ADJUST: 'Разница по факту',
  MANUAL_ADJUST: 'Корректировка',
  DEBT_OPEN: 'Долг по заявке',
  DEBT_REPAY: 'Погашение долга',
};

export const signed = (minor: bigint): string => (minor > 0n ? `+${formatRub(minor)}` : formatRub(minor));

export const balanceText = (minor: bigint): string => (minor < 0n ? `Долг: <b>${formatRub(-minor)}</b>` : `Баланс: <b>${formatRub(minor)}</b>`);

const fmtDate = (d: Date, tz: string) =>
  new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d);

export const ledgerLine = (e: LedgerEntry, tz: string): string =>
  `${fmtDate(e.createdAt, tz)} · ${LEDGER_LABEL[e.type]}${e.orderId ? ` #${e.orderId}` : ''}: <b>${signed(e.amountMinor)}</b>`;

export const b = {
  btnBalance: '💰 Мой баланс',
  btnTopUp: '➕ Пополнить баланс',
  topUpBtn: 'Пополнить',
  repayBtn: (debt: bigint) => `Погасить долг ${formatRub(debt)}`,

  screen: (p: { balance: bigint; pending: number; entries: LedgerEntry[]; tz: string }) => {
    const lines = [`<b>Мой баланс</b>`, balanceText(p.balance)];
    if (p.balance < 0n) lines.push('Долг будет списан из следующих пополнений.');
    if (p.pending > 0) lines.push(`Пополнений на проверке: ${p.pending}`);
    lines.push('', p.entries.length ? '<b>Последние операции</b>' : 'Операций пока нет.');
    for (const e of p.entries) lines.push(ledgerLine(e, p.tz));
    return lines.join('\n');
  },

  // ── Пополнение ──
  stepAmount: (debt: bigint) =>
    `Сколько рублей хочешь внести?${debt > 0n ? `\nУ тебя долг ${formatRub(debt)} — можно погасить его кнопкой ниже.` : ''}`,
  badAmount: 'Не удалось разобрать сумму. Пример: 5000 или 5000,50',
  amountLimit: 'Сумма должна быть от 1 до 10 000 000 ₽.',
  noMethods: 'Способы пополнения ещё не настроены — напиши админу.',
  chooseMethod: 'Как будешь переводить?',
  transferInstructions: (amount: bigint, m: PaymentMethod) =>
    `Переведи <b>${formatRub(amount)}</b>\nСпособ: <b>${escapeHtml(m.title)}</b>\n\n${escapeHtml(m.instructions)}`,
  sendReceipt: 'После перевода пришли скриншот или файл чека (фото / PDF).',
  topUpSent: (id: number) => `Заявка на пополнение #${id} отправлена. Как только админ подтвердит поступление, деньги появятся на балансе.`,
  topUpSentNoReceipt: (id: number, instructions: string) =>
    `Заявка на пополнение #${id} отправлена. ${instructions}\nАдмин подтвердит поступление вручную.`,
  topUpConfirmed: (amount: bigint, balance: bigint) =>
    `✅ Пополнение на ${formatRub(amount)} подтверждено.\n${balanceText(balance)}`,
  topUpRejected: (id: number) => `❌ Пополнение #${id} отклонено — поступление не найдено. Если это ошибка, напиши админу.`,

  // ── Админ ──
  adminTopUp: (t: { id: number; client: User; amount: bigint; method: string; receipt: boolean; debt: bigint }) =>
    `<b>💰 Пополнение #${t.id}</b>\nКлиент: #${t.client.id} ${escapeHtml(t.client.displayName)}${t.client.username ? ` (@${escapeHtml(t.client.username)})` : ''}\nСумма: <b>${formatRub(t.amount)}</b>\nСпособ: ${escapeHtml(t.method)}${t.receipt ? '\nЧек: см. сообщение выше' : '\nЧек не требуется'}${t.debt > 0n ? `\nДолг клиента: ${formatRub(t.debt)} — будет погашен в первую очередь` : ''}`,
  confirmTopUp: '✅ Подтвердить',
  rejectTopUp: '❌ Не найдено',
  topUpDone: (id: number, balance: bigint) => `Пополнение #${id} подтверждено. ${balanceText(balance).replace(/<\/?b>/g, '')}`,
  topUpDeclined: (id: number) => `Пополнение #${id} отклонено.`,
  topUpAlready: 'Уже обработано.',

  debtsTitle: '<b>Долги и переплаты</b>',
  noDebts: 'Долгов и переплат нет.',
  debtsSection: (title: string, lines: string[], total: bigint) =>
    lines.length ? `\n<b>${title}</b> (итого ${formatRub(total < 0n ? -total : total)})\n${lines.join('\n')}` : '',
  debtLine: (c: User, amount: bigint) =>
    `#${c.id} ${escapeHtml(c.displayName)}${c.username ? ` @${escapeHtml(c.username)}` : ''} — ${formatRub(amount < 0n ? -amount : amount)}`,

  clientCard: (c: User, balance: bigint, entries: LedgerEntry[], tz: string) =>
    [
      `<b>Клиент #${c.id}</b> ${escapeHtml(c.displayName)}${c.username ? ` @${escapeHtml(c.username)}` : ''}`,
      `Статус: ${c.status === 'BLOCKED' ? '🚫 заблокирован' : 'активен'}`,
      `Оплата позже: ${c.payLaterEnabled ? `включена, лимит ${formatRub(c.payLaterLimitMinor)}` : 'выключена'}`,
      balanceText(balance),
      '',
      entries.length ? '<b>Последние операции</b>' : 'Операций нет.',
      ...entries.map((e) => ledgerLine(e, tz)),
    ].join('\n'),

  adjustUsage: 'Использование: /adjust <id> <+/-сумма ₽> [комментарий]\nПример: /adjust 3 -150 возврат за подписку',
  adjustDone: (c: User, amount: bigint, balance: bigint) =>
    `Готово: клиенту #${c.id} ${signed(amount)}. ${balanceText(balance).replace(/<\/?b>/g, '')}`,
  adjustNotice: (amount: bigint, balance: bigint, comment: string | null) =>
    `Админ скорректировал баланс: <b>${signed(amount)}</b>${comment ? ` (${escapeHtml(comment)})` : ''}\n${balanceText(balance)}`,

  debtReminder: (debt: bigint) =>
    `⏰ Напоминание: за тобой долг <b>${formatRub(debt)}</b>.\nПогасить можно переводом — кнопка ниже.`,
};

export { formatMinor };
