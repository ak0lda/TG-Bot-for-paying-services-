import type { AdminCard, PaymentMethod } from '@prisma/client';
import { formatRate } from '../domain/pricing.js';
import { escapeHtml } from './ru.js';

export const c = {
  cardsEmpty: 'Карт нет. Добавь: /card_add Visa ··4417 USD',
  cardLine: (x: AdminCard) => `#${x.id} ${escapeHtml(x.label)} (${x.currency}) — ${x.isActive ? 'активна' : 'выключена'}`,
  cardsHint: '\n\nДобавить: /card_add &lt;метка&gt; &lt;ВАЛ&gt; · вкл/выкл: /card_toggle &lt;id&gt;\nХраню только метку и валюту — без номеров и реквизитов.',
  cardUsage: 'Использование: /card_add Visa ··4417 USD',
  cardBad: 'Метка 2–30 символов, без номера карты (подойдёт «Visa ··4417»). Валюта — трёхбуквенный код.',
  cardAdded: (x: AdminCard) => `Карта добавлена: #${x.id} ${escapeHtml(x.label)} (${x.currency})`,
  cardNotFound: 'Карта не найдена.',
  cardToggled: (x: AdminCard) => `Карта #${x.id} ${x.isActive ? 'включена' : 'выключена'}.`,

  methodsEmpty: 'Способов оплаты нет. Добавь: /method_add Название | Инструкции | да',
  methodLine: (m: PaymentMethod) =>
    `<b>#${m.id} ${escapeHtml(m.title)}</b> — ${m.isActive ? 'активен' : 'выключен'}, чек ${m.requiresReceipt ? 'нужен' : 'не нужен'}\n${escapeHtml(m.instructions)}`,
  methodsHint:
    '\n\n/method_add Название | Инструкции | да/нет (чек)\n/method_edit &lt;id&gt; | Новые инструкции\n/method_receipt &lt;id&gt; да/нет\n/method_toggle &lt;id&gt;',
  methodUsage: 'Использование: /method_add Название | Инструкции | да',
  methodBad: 'Название 2–40 символов, инструкции 2–1000.',
  methodHasCard:
    'В тексте похоже на номер банковской карты. Номера карт в боте не храним — укажи вместо него телефон СБП, банк и имя получателя.',
  methodAdded: (m: PaymentMethod) => `Способ добавлен: #${m.id} ${escapeHtml(m.title)}`,
  methodNotFound: 'Способ не найден.',
  methodUpdated: (m: PaymentMethod) => `Обновлено: #${m.id} ${escapeHtml(m.title)} — ${m.isActive ? 'активен' : 'выключен'}, чек ${m.requiresReceipt ? 'нужен' : 'не нужен'}.`,

  rateHeader: '<b>Курсы</b> (ручной курс приоритетнее ЦБ)',
  rateLine: (cur: string, scaled: bigint, src: string, time: string) => `${cur}: <b>${formatRate(scaled)}</b> — ${src}, ${time}`,
  rateNone: (cur: string) => `${cur}: нет данных`,
  rateUsage: 'Использование: /rate · /rate USD 95,5 · /rate USD clear',
  rateSet: (cur: string, scaled: bigint) => `Ручной курс ${cur} = ${formatRate(scaled)} ₽.`,
  rateCleared: (cur: string) => `Ручной курс ${cur} сброшен, снова ЦБ.`,
  rateBad: 'Не удалось разобрать курс. Пример: /rate USD 95,5',
};
