import type { OrderStatus, OrderType, PeriodKind } from '@prisma/client';
import { escapeHtml } from './ru.js';

export const STATUS_LABEL: Record<OrderStatus, string> = {
  NEW: '🆕 Новая',
  QUOTED: '💬 Рассчитана',
  AWAITING_PAYMENT: '💳 Ждём оплату',
  PAYMENT_CHECK: '🔎 Проверка оплаты',
  IN_PROGRESS: '⚙️ В работе',
  DONE: '✅ Выполнена',
  CANCELED: '🚫 Отменена',
  REJECTED: '❌ Отклонена',
  EXPIRED: '⌛ Расчёт истёк',
  LINK_INVALID: '🔗 Ссылка не работает',
};

export const STATUS_EMOJI: Record<OrderStatus, string> = Object.fromEntries(
  Object.entries(STATUS_LABEL).map(([k, v]) => [k, v.split(' ')[0]]),
) as Record<OrderStatus, string>;

export const TYPE_LABEL: Record<OrderType, string> = {
  PAYMENT_LINK: 'Ссылка на оплату',
  GIFT_CARD: 'Подарочная карта / код',
  TOP_UP: 'Пополнение баланса сервиса',
  OTHER: 'Другое',
};

export const periodLabel = (kind: PeriodKind | null, days: number | null): string =>
  kind === 'MONTH' ? 'месяц' : kind === 'YEAR' ? 'год' : kind === 'CUSTOM' ? `${days} дн.` : '—';

export const LINK_REMINDER =
  '⏱ Ссылка на оплату может истечь, поэтому после расчёта лучше сразу переводить деньги.';

export const o = {
  // ── Меню ──
  btnNew: '➕ Новая заявка',
  btnMy: '📋 Мои заявки',
  menuHint: 'Выбери действие в меню ниже.',
  unknown: 'Не понял. Используй меню ниже или /start.',
  noOrders: 'Заявок пока нет. Нажми «➕ Новая заявка».',
  myOrdersTitle: 'Твои последние заявки:',
  openOrdersTitle: 'Открытые заявки:',
  noOpenOrders: 'Открытых заявок нет.',

  // ── Диалог ──
  cancelBtn: '✖ Отмена',
  skipBtn: 'Пропустить',
  wizardCanceled: 'Отменено.',
  wizardExpired: 'Диалог устарел. Начни заново.',
  buttonStale: 'Кнопка устарела',
  useButtons: 'Пожалуйста, выбери вариант кнопкой.',
  needText: 'Нужен текст.',
  needFile: 'Пришли фото или файл.',
  secretWarning:
    '⚠️ Похоже, ты прислал пароль, код или данные банковской карты. Я такое не принимаю и не сохраняю — сообщение удалено (если смог). Опиши то же самое без личных данных.',
  stepType: 'Что нужно оплатить?',
  stepUrl: (optional: boolean) =>
    `Пришли <b>полную https-ссылку</b> на оплату${optional ? ' (или нажми «Пропустить»)' : ''}.\n\n${LINK_REMINDER}`,
  stepServiceGift: 'Магазин / сервис (например: App Store, Google Play, Steam, Amazon):',
  stepService: 'Название сервиса (например: Netflix, Hetzner, OpenAI):',
  stepRegion: 'Регион подарочной карты (например: US, TR, EU):',
  stepDescription: (type: OrderType) =>
    type === 'TOP_UP'
      ? 'Что пополняем? (например: API-кредиты, хостинг-баланс):'
      : type === 'OTHER'
        ? 'Опиши, что нужно оплатить (подробно — админ решит, можно ли выполнить):'
        : 'Тариф / что именно оплачиваем:',
  stepAmount: (gift: boolean) =>
    `${gift ? 'Номинал' : 'Сумма со страницы оплаты'}, число. Можно сразу с валютой: <code>15,99 USD</code>`,
  stepCurrency: 'Валюта (кнопкой или напиши код, например CHF):',
  stepPeriod: 'Это разовая оплата или подписка?',
  stepPeriodDays: 'Через сколько дней следующее списание? (1–730)',
  stepComment: 'Комментарий для админа (или «Пропустить»):',
  badText: (min: number, max: number) => `Нужен текст длиной от ${min} до ${max} символов.`,
  badAmount: 'Не удалось разобрать сумму. Пример: 15,99 или 15,99 USD',
  amountLimit: 'Слишком большая или нулевая сумма.',
  badCurrency: 'Нужен трёхбуквенный код валюты, например USD.',
  rubCurrency: 'Для рублей заявка не нужна — просто переведи деньги напрямую.',
  noRate: (cur: string) => `Не нашёл курс для ${escapeHtml(cur)}. Попробуй другой код валюты или напиши админу.`,
  badDays: 'Нужно целое число от 1 до 730.',
  link: {
    invalid: 'Это не похоже на ссылку. Пришли полный адрес вида https://…',
    not_https: 'Принимаю только https-ссылки.',
    shortener: 'Сокращённые ссылки (bit.ly, t.co и т.п.) не принимаю — пришли полную ссылку со страницы оплаты.',
    credentials: 'В ссылке есть логин/пароль — так нельзя. Пришли ссылку без них.',
    too_long: 'Ссылка слишком длинная.',
  } as const,
  summaryTitle: 'Проверь заявку:',
  sendBtn: '✅ Отправить',
  orderCreated: (id: number) => `Заявка #${id} создана. Админ скоро рассчитает сумму.`,
  untrustedNote: '⚠️ Домен не из списка доверенных — админ дополнительно проверит ссылку.',

  // ── Клиент ──
  quoteReady: (id: number) => `💬 Заявка #${id} рассчитана.`,
  expiredNotice: (id: number) => `⌛ Расчёт по заявке #${id} истёк. Нажми «Пересчитать», чтобы получить актуальную сумму.`,
  expiredNow: 'Расчёт истёк. Нажми «Пересчитать».',
  noMethods: 'Способы оплаты ещё не настроены — напиши админу.',
  chooseMethod: 'Как будешь переводить деньги?',
  payInstructions: (total: string, method: string, instructions: string) =>
    `💳 К оплате: <b>${total}</b>\nСпособ: <b>${escapeHtml(method)}</b>\n\n${escapeHtml(instructions)}\n\nПосле перевода нажми «Я оплатил».`,
  sendReceipt: 'Пришли скриншот или файл чека (фото / PDF).',
  paidAccepted: (id: number) => `Спасибо! Проверю поступление по заявке #${id} и вернусь с ответом.`,
  paymentConfirmed: (id: number) => `✅ Оплата по заявке #${id} подтверждена, заявка в работе.`,
  paymentNotFound: (id: number) =>
    `Не вижу оплату по заявке #${id}. Проверь перевод и нажми «Я оплатил» ещё раз (с чеком).`,
  linkInvalidNotice: (id: number) =>
    `🔗 Ссылка по заявке #${id} не работает. Пришли новую — оплата сохранена.\n\n${LINK_REMINDER}`,
  newLinkAccepted: 'Спасибо, новая ссылка отправлена админу.',
  canceledByClient: (id: number) => `Заявка #${id} отменена.`,
  balanceKept: 'Внесённая тобой сумма осталась на твоём балансе в боте.',
  rejectedNotice: (id: number, reason: string) => `❌ Заявка #${id} отклонена.\nПричина: ${escapeHtml(reason)}`,
  doneNotice: (id: number) => `✅ Заявка #${id} выполнена.`,
  overpay: (x: string) => `Переплата ${x} зачислена на твой баланс.`,
  underpay: (x: string) => `Доплата ${x} учтена на твоём балансе.`,
  balanceLine: (x: string) => `Баланс: <b>${x}</b>`,
  giftCodeMsg: (id: number, code: string) => `🎁 Код по заявке #${id}:\n<code>${escapeHtml(code)}</code>`,

  // ── Админ ──
  adminNewOrder: '🆕 Новая заявка',
  adminCanceled: (id: number, wasChecking: boolean) =>
    `🚫 Клиент отменил заявку #${id}.${wasChecking ? '\n⚠️ Она была на проверке оплаты — убедись, что перевод не нужно вернуть.' : ''}`,
  adminPaid: (id: number) => `💳 Клиент отметил оплату по заявке #${id}.`,
  adminNewLink: (id: number) => `🔗 Клиент прислал новую ссылку по заявке #${id}.`,
  adminRequoted: (id: number) => `🔄 Клиент пересчитал заявку #${id}.`,
  rejectReasonPrompt: 'Причина отклонения (увидит клиент):',
  giftCodePrompt: 'Введи код подарочной карты (отправится клиенту, в БД хранится зашифрованным):',
  cardPrompt: 'Какой картой платил?',
  noCards: 'Нет активных карт. Добавь: /card_add Visa ··4417 USD',
  actualPrompt: (cur: string) => `Сколько фактически списано, в ${escapeHtml(cur)}? (число)`,
  ratePrompt: (cur: string, rate: string, source: string) =>
    `Курс ${escapeHtml(cur)}→₽ для пересчёта факта: <b>${rate}</b> (${source}).\nПринять или введи свой курс числом.`,
  acceptRate: 'Принять курс',
  rateUnavailable: (cur: string) => `Курс ${escapeHtml(cur)} недоступен. Введи его числом (₽ за 1 ${escapeHtml(cur)}):`,
  badRate: 'Не удалось разобрать курс. Пример: 92,35',
  screenshotPrompt: 'Приложи скриншот/чек списания или нажми «Пропустить».',
  doneSummary: (p: { actualRub: string; base: string; diff: string; diffKind: string; actual: string; card: string }) =>
    `<b>Итог по заявке</b>\nКарта: ${escapeHtml(p.card)}\nСписано: ${escapeHtml(p.actual)} ≈ ${p.actualRub}\nОценка по расчёту: ${p.base}\nРазница: <b>${p.diff}</b> — ${p.diffKind}`,
  diffOver: 'переплата клиента (зачтём на баланс)',
  diffUnder: 'доплата клиента (спишем с баланса)',
  diffZero: 'без разницы',
  confirmBtn: '✅ Подтвердить',
  doneByAdmin: (id: number) => `✅ Заявка #${id} выполнена.`,
  stale: 'Карточка устарела — показываю актуальную.',
  alreadyDone: 'Уже обработано.',
  forbidden: 'Нет доступа.',
  notFound: 'Заявка не найдена.',
  invalidAction: 'Это действие сейчас недоступно.',
  rateErr: (cur: string) => `Нет курса для ${cur}. Задай вручную: /rate ${cur} 95,5`,
  quoteFailed: 'Не удалось получить курс. Задай вручную: /rate USD 95,5',
};
