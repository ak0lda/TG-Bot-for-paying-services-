import type { User } from '@prisma/client';
import { formatUsdt } from '../domain/crypto-invoice.js';
import { formatRub } from '../domain/money.js';
import { formatRate } from '../domain/pricing.js';
import { escapeHtml } from './ru.js';

export const cx = {
  kindPrompt: 'Как пополнить баланс?',
  kindRub: '₽ Перевод (СБП / на карту)',
  kindUsdt: '💎 USDT (TRC-20)',
  usdtAmountPrompt: (min: number, max: number) =>
    `Сколько USDT вы хотите отправить? От ${min} до ${max} (до 2 знаков после запятой).`,
  usdtBadAmount: 'Не удалось разобрать сумму. Пример: 50 или 50,5',
  usdtLimit: (min: number, max: number) => `Сумма должна быть от ${min} до ${max} USDT.`,
  disabled: 'Пополнение в USDT сейчас недоступно.',
  rateUnavailable: 'Курс сейчас недоступен — попробуйте позже.',
  invoice: (p: {
    id: number;
    address: string;
    amountMicro: bigint;
    creditMinor: bigint;
    rateScaled: bigint;
    feeBp: number;
    expires: string;
  }) =>
    [
      `💎 <b>Пополнение #${p.id} в USDT</b>`,
      '',
      `Отправьте <b>ровно ${formatUsdt(p.amountMicro)} USDT</b> по сети <b>TRON (TRC-20)</b> на адрес:`,
      `<code>${escapeHtml(p.address)}</code>`,
      '',
      `⚠️ Только сеть TRC-20 и только USDT. Сумма должна совпадать до последней цифры — по ней бот находит ваш перевод. Переводы в другой сети или на другую сумму могут быть потеряны.`,
      '',
      `На баланс зачислится: <b>${formatRub(p.creditMinor)}</b> (курс ${formatRate(p.rateScaled)} ₽, комиссия ${(p.feeBp / 100).toString().replace('.', ',')}%, зафиксировано сейчас).`,
      `Счёт действует до ${p.expires}.`,
      'После перевода ничего нажимать не нужно: бот сам заметит платёж, зачисление подтвердит администратор.',
    ].join('\n'),
  cancelBtn: 'Отменить счёт',
  cancelled: (id: number) =>
    `Счёт #${id} отменён. Если вы уже отправили перевод — не отменяйте, напишите администратору.`,
  cancelTooLate: 'Счёт уже оплачен или закрыт.',
  seen: (id: number) => `✅ Перевод по счёту #${id} замечен в сети. Администратор подтвердит зачисление.`,
  expired: (id: number) => `Счёт #${id} истёк без оплаты. Если вы всё же отправили USDT — напишите администратору.`,
  adminCard: (p: {
    id: number;
    client: User;
    amountMicro: bigint;
    creditMinor: bigint;
    txid: string | null;
    expires: string;
    debt: bigint;
  }) =>
    `<b>💎 Пополнение #${p.id} (USDT TRC-20)</b>\nКлиент: #${p.client.id} ${escapeHtml(p.client.displayName)}${p.client.username ? ` (@${escapeHtml(p.client.username)})` : ''}\nСумма: <b>${formatUsdt(p.amountMicro)} USDT</b> → зачислить <b>${formatRub(p.creditMinor)}</b>\n${
      p.txid
        ? `✅ Перевод найден в сети (подтверждён). Tx: <code>${p.txid}</code>`
        : `⏳ Перевода пока нет. Счёт действует до ${p.expires}.`
    }${p.debt > 0n ? `\nДолг клиента: ${formatRub(p.debt)} — будет погашен в первую очередь` : ''}`,
  adminSeen: (id: number) => `💎 Пришёл USDT-перевод по пополнению #${id}. Проверь и подтверди зачисление.`,
  notPaid: 'Перевода по этому счёту ещё нет в сети.',
  unmatched: (amountMicro: bigint, txid: string, from: string, expiredId: number | null) =>
    `⚠️ Входящий USDT без счёта: ${formatUsdt(amountMicro)} USDT\nОт: <code>${escapeHtml(from)}</code>\nTx: <code>${txid}</code>${
      expiredId
        ? `\nСумма совпадает с просроченным счётом #${expiredId} — вероятно, клиент оплатил после истечения.`
        : ''
    }\nРазбери вручную (в т.ч. через «Баланс» клиента → корректировка).`,
  pollFailed:
    'Не удаётся прочитать переводы USDT из сети TRON (TronGrid). Новые платежи могут обрабатываться с задержкой.',
  status: (p: { address: string; pending: number; lastSeen: string | null }) =>
    `💎 USDT TRC-20\nАдрес: <code>${escapeHtml(p.address)}</code>\nОткрытых счетов: ${p.pending}\nПоследний перевод: ${p.lastSeen ?? 'нет'}`,
  statusOff: 'Приём USDT выключен (CRYPTO_USDT_TRON_ADDRESS не задан).',
  tronscanBtn: 'TronScan',
};
