import type { AdminCard, PaymentMethod } from '@prisma/client';
import { formatMinor, formatRub } from '../domain/money.js';
import { formatRate } from '../domain/pricing.js';
import { escapeHtml } from './ru.js';

const periodShort = (k: string | null, d: number | null) =>
  k === 'MONTH' ? 'мес' : k === 'YEAR' ? 'год' : k === 'CUSTOM' ? `${d} дн` : '';

export const c = {
  presetsEmpty: 'Частых сервисов нет. Добавь: /preset_add Netflix | PAYMENT_LINK | USD | 15,99 | MONTH',
  presetsList: (
    list: Array<{
      id: number;
      name: string;
      type: string;
      currency: string | null;
      amountMinor: bigint | null;
      periodKind: string | null;
      periodDays: number | null;
    }>,
  ) =>
    `<b>Частые сервисы</b> (подсказки клиентам)\n${list
      .map(
        (p) =>
          `#${p.id} ${escapeHtml(p.name)} — ${p.type}${p.amountMinor != null ? `, ${formatMinor(p.amountMinor)} ${p.currency}` : ''}${p.periodKind ? `, ${periodShort(p.periodKind, p.periodDays)}` : ''}`,
      )
      .join('\n')}\n\nУдалить: /preset_del &lt;id&gt;`,
  presetUsage:
    'Формат: /preset_add Название | ТИП | ВАЛ | СУММА | ПЕРИОД — всё, кроме названия, необязательно (- = не задано). Пример: /preset_add Netflix | PAYMENT_LINK | USD | 15,99 | MONTH',
  presetAdded: (p: { id: number; name: string }) => `Добавлено: #${p.id} ${escapeHtml(p.name)}`,
  presetExists: 'Сервис с таким названием уже есть.',
  presetDeleted: 'Удалено.',
  presetNotFound: 'Не найдено.',
  cardsEmpty: 'Карт нет. Добавь: /card_add Visa ··4417 USD',
  cardLine: (x: AdminCard) =>
    `#${x.id} ${escapeHtml(x.label)} (${x.currency}) — ${x.isActive ? 'активна' : 'выключена'}`,
  cardsHint:
    '\n\nДобавить: /card_add &lt;метка&gt; &lt;ВАЛ&gt; · вкл/выкл: /card_toggle &lt;id&gt;\nХраню только метку и валюту — без номеров и реквизитов.',
  cardUsage: 'Использование: /card_add Visa ··4417 USD',
  cardBad: 'Метка 2–30 символов, без номера карты (подойдёт «Visa ··4417»). Валюта — трёхбуквенный код.',
  cardAdded: (x: AdminCard) => `Карта добавлена: #${x.id} ${escapeHtml(x.label)} (${x.currency})`,
  cardNotFound: 'Карта не найдена.',
  cardToggled: (x: AdminCard) => `Карта #${x.id} ${x.isActive ? 'включена' : 'выключена'}.`,

  methodsEmpty: 'Способов оплаты нет. Добавь: /method_add СБП | - | да',
  methodLine: (m: PaymentMethod) => {
    const limits =
      m.minAmountMinor == null && m.maxAmountMinor == null
        ? 'без ограничений по сумме'
        : `сумма ${m.minAmountMinor != null ? `от ${formatRub(m.minAmountMinor)}` : ''}${m.minAmountMinor != null && m.maxAmountMinor != null ? ' ' : ''}${m.maxAmountMinor != null ? `до ${formatRub(m.maxAmountMinor)}` : ''}`;
    const auto = m.autoSend
      ? m.instructions
        ? '🤖 автоотправка: вкл'
        : '🤖 автоотправка: вкл, но нет текста — не сработает'
      : 'автоотправка: выкл';
    return `<b>#${m.id} ${escapeHtml(m.title)}</b> — ${m.isActive ? 'активен' : 'выключен'}, чек ${m.requiresReceipt ? 'нужен' : 'не нужен'}\n${limits}; ${auto}\n${
      m.instructions
        ? `Текст реквизитов: ${escapeHtml(m.instructions)}`
        : 'Текста нет — реквизиты присылаешь вручную по каждой заявке'
    }`;
  },
  methodsHint:
    '\n\n<b>Автоотправка.</b> Задай способу текст реквизитов, границы суммы и включи автоотправку — когда клиент подтвердит заявку или попросит пополнение, сервер сам выберет подходящий по сумме способ и пришлёт реквизиты. Подходящих нет — карточка придёт тебе, как раньше.\n' +
    'Текст реквизитов хранится в базе бота (не в git); номера банковских карт в нём запрещены.\n\n' +
    '/method_add Название | Текст реквизитов или - | да/нет (чек)\n/method_edit &lt;id&gt; | Новый текст (или -)\n' +
    '/method_limits &lt;id&gt; &lt;от ₽&gt; &lt;до ₽&gt; (- = без границы) | /method_limits &lt;id&gt; off\n/method_auto &lt;id&gt; on|off\n' +
    '/method_receipt &lt;id&gt; да/нет · /method_toggle &lt;id&gt;',
  limitsUsage:
    'Использование: /method_limits <id> <от ₽> <до ₽> (- = без границы) или /method_limits <id> off\nПример: /method_limits 2 5800 640000',
  limitsBad: 'Не удалось разобрать суммы, либо «от» больше «до».',
  limitsSet: (m: PaymentMethod) => `Границы обновлены: ${m.title}.`,
  autoUsage: 'Использование: /method_auto <id> on|off',
  autoNeedsText: 'Сначала задай текст реквизитов: /method_edit <id> | текст',
  autoSet: (m: PaymentMethod) => `Автоотправка для «${m.title}»: ${m.autoSend ? 'включена' : 'выключена'}.`,
  methodUsage: 'Использование: /method_add Название | Готовый текст или - | да',
  methodBad: 'Название 2–40 символов, готовый текст — до 1000.',
  methodHasCard:
    'В тексте похоже на номер банковской карты. Номера карт в боте не храним — укажи вместо него телефон СБП, банк и имя получателя.',
  methodAdded: (m: PaymentMethod) => `Способ добавлен: #${m.id} ${escapeHtml(m.title)}`,
  methodNotFound: 'Способ не найден.',
  methodUpdated: (m: PaymentMethod) =>
    `Обновлено: #${m.id} ${escapeHtml(m.title)} — ${m.isActive ? 'активен' : 'выключен'}, чек ${m.requiresReceipt ? 'нужен' : 'не нужен'}.`,

  rateHeader: '<b>Курсы</b> (ручной курс приоритетнее ЦБ)',
  rateLine: (cur: string, scaled: bigint, src: string, time: string) =>
    `${cur}: <b>${formatRate(scaled)}</b> — ${src}, ${time}`,
  rateNone: (cur: string) => `${cur}: нет данных`,
  rateUsage: 'Использование: /rate · /rate USD 95,5 · /rate USD clear',
  rateSet: (cur: string, scaled: bigint) => `Ручной курс ${cur} = ${formatRate(scaled)} ₽.`,
  rateCleared: (cur: string) => `Ручной курс ${cur} сброшен, снова ЦБ.`,
  rateBad: 'Не удалось разобрать курс. Пример: /rate USD 95,5',
};
