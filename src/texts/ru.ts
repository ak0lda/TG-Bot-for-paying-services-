import type { User } from '@prisma/client';
import { formatRub } from '../domain/money.js';
import { SETTING_DEFS, SETTING_KEYS, formatSettingValue, type Settings } from '../domain/settings.js';

export const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const t = {
  accessDenied: 'Это закрытый бот. Доступ только по приглашению — попроси у владельца ссылку-приглашение.',
  inviteInvalid: 'Код приглашения недействителен, уже использован или истёк. Попроси новый.',
  blocked: 'Доступ к боту закрыт. Если это ошибка — свяжись с владельцем.',
  rateLimited: 'Слишком часто. Подожди пару секунд.',
  internalError: 'Что-то пошло не так. Попробуй ещё раз позже.',
  adminOnly: 'Команда доступна только администратору.',

  welcomeClient: (name: string) =>
    `Привет, ${escapeHtml(name)}! Ты зарегистрирован.\nСоздай заявку на оплату сервиса или посмотри свои заявки — кнопки в меню.`,
  welcomeAdmin:
    'Режим администратора.\n\n' +
    '/invite [заметка] — создать инвайт\n' +
    '/invites — активные инвайты\n' +
    '/clients — клиенты\n' +
    '/block &lt;id&gt; · /unblock &lt;id&gt;\n' +
    '/paylater &lt;id&gt; on [лимит ₽] | off\n' +
    '/settings [ключ значение]\n' +
    '/domains · /domain_add &lt;домен&gt; · /domain_del &lt;домен&gt;\n' +
    '/domain_ban &lt;домен&gt; [причина] · /domain_unban · /banned — чёрный список ссылок\n\n' +
    '💰 Пришли мне текст уведомления банка о поступлении — найду заявку и предложу подтвердить.\n' +
    '/orders — открытые заявки · /calc 15,99 USD — оценка стоимости\n' +
    '/stats [период] · /export [период] · /subs · /fx [дней] — подбор запаса на конвертацию\n' +
    '/debts — долги и переплаты · /client &lt;id&gt; — карточка клиента\n' +
    '/adjust &lt;id&gt; &lt;±сумма&gt; [комментарий] — корректировка баланса\n' +
    '/rate [ВАЛ [курс|clear]] — курсы\n' +
    '/presets · /preset_add · /preset_del — частые сервисы (подсказки)\n' +
    '/cards · /card_add &lt;метка&gt; &lt;ВАЛ&gt; · /card_toggle &lt;id&gt;\n' +
    '/methods · /method_add · /method_edit · /method_limits · /method_auto · /method_receipt · /method_toggle',
  helpClient:
    'Используй кнопки меню: «➕ Новая заявка» и «📋 Мои заявки». /calc 15,99 USD — прикинуть стоимость, /cancel — отменить текущий диалог.',

  newClientNotice: (u: User) =>
    `Новый клиент: #${u.id} ${escapeHtml(u.displayName)}${u.username ? ` (@${escapeHtml(u.username)})` : ''}`,

  inviteCreated: (link: string, code: string, hours: number) =>
    `Инвайт создан (действует ${hours} ч, одноразовый):\n${escapeHtml(link)}\n\nКод: <code>${escapeHtml(code)}</code>`,
  invitesEmpty: 'Активных инвайтов нет.',
  inviteLine: (code: string, expiresAt: Date, note: string | null) =>
    `<code>${escapeHtml(code)}</code> — до ${expiresAt.toISOString().slice(0, 16).replace('T', ' ')} UTC${note ? ` — ${escapeHtml(note)}` : ''}`,

  clientsEmpty: 'Клиентов пока нет.',
  clientLine: (u: User, balance = 0n) =>
    `#${u.id} ${escapeHtml(u.displayName)}${u.username ? ` @${escapeHtml(u.username)}` : ''} — ${
      u.status === 'BLOCKED' ? '🚫 заблокирован' : 'активен'
    }${u.payLaterEnabled ? `, оплата позже: до ${formatRub(u.payLaterLimitMinor)}` : ''}${
      balance === 0n ? '' : balance < 0n ? `, долг ${formatRub(-balance)}` : `, баланс ${formatRub(balance)}`
    }`,
  clientNotFound: 'Клиент не найден.',
  usage: (s: string) => `Использование: ${s}`,
  clientBlocked: (u: User) => `Клиент #${u.id} заблокирован.`,
  clientUnblocked: (u: User) => `Клиент #${u.id} разблокирован.`,
  payLaterOn: (u: User) => `Оплата позже включена для #${u.id}, лимит ${formatRub(u.payLaterLimitMinor)}.`,
  payLaterOff: (u: User) => `Оплата позже выключена для #${u.id}.`,
  badAmount: 'Не удалось разобрать сумму. Пример: 5000 или 5000,50',

  settingsList: (s: Settings) =>
    '<b>Настройки</b>\n' +
    SETTING_KEYS.map(
      (k) => `<code>${k}</code> = ${formatSettingValue(k, s[k])} — ${escapeHtml(SETTING_DEFS[k].label)}`,
    ).join('\n') +
    '\n\nИзменить: /settings &lt;ключ&gt; &lt;значение&gt;',
  settingUnknown: 'Неизвестный ключ. Список: /settings',
  settingBad: (why: string) => `Не удалось: ${escapeHtml(why)}.`,
  settingSaved: (key: string, value: string) => `Сохранено: <code>${key}</code> = ${value}`,

  domainsList: (domains: string[]) =>
    domains.length
      ? `<b>Доверенные домены</b>\n${domains.map(escapeHtml).join('\n')}`
      : 'Список доверенных доменов пуст.',
  domainBad: 'Не похоже на домен. Пример: /domain_add checkout.stripe.com',
  domainAdded: (d: string) => `Домен добавлен: ${escapeHtml(d)}`,
  domainExists: 'Такой домен уже в списке.',
  domainRemoved: (d: string) => `Домен удалён: ${escapeHtml(d)}`,
  domainMissing: 'Такого домена нет в списке.',
  banned: (domain: string, open: number) =>
    `⛔ Домен ${escapeHtml(domain)} в чёрном списке — новые заявки с ним не принимаются.${open ? `\nОткрытых заявок с этим доменом: ${open} — проверь их: /orders` : ''}`,
  banExists: 'Домен уже в чёрном списке.',
  unbanned: (domain: string) => `Домен ${escapeHtml(domain)} убран из чёрного списка.`,
  bannedEmpty: 'Чёрный список пуст.',
  bannedList: (rows: string[]) => `<b>Чёрный список доменов</b>\n${rows.join('\n')}`,
};
