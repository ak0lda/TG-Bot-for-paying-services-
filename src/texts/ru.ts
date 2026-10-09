import type { User } from '@prisma/client';
import { formatRub } from '../domain/money.js';
import { SETTING_DEFS, SETTING_KEYS, formatSettingValue, type Settings } from '../domain/settings.js';

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const t = {
  accessDenied:
    'Это закрытый бот. Доступ только по приглашению — попроси у владельца ссылку-приглашение.',
  inviteInvalid: 'Код приглашения недействителен, уже использован или истёк. Попроси новый.',
  blocked: 'Доступ к боту закрыт. Если это ошибка — свяжись с владельцем.',
  rateLimited: 'Слишком часто. Подожди пару секунд.',
  internalError: 'Что-то пошло не так. Попробуй ещё раз позже.',
  adminOnly: 'Команда доступна только администратору.',

  welcomeClient: (name: string) =>
    `Привет, ${escapeHtml(name)}! Ты зарегистрирован.\nЗаявки на оплату сервисов появятся на следующем этапе — пока бот в настройке.`,
  welcomeAdmin:
    'Режим администратора.\n\n' +
    '/invite [заметка] — создать инвайт\n' +
    '/invites — активные инвайты\n' +
    '/clients — клиенты\n' +
    '/block &lt;id&gt; · /unblock &lt;id&gt;\n' +
    '/paylater &lt;id&gt; on [лимит ₽] | off\n' +
    '/settings [ключ значение]\n' +
    '/domains · /domain_add &lt;домен&gt; · /domain_del &lt;домен&gt;',
  helpClient: 'Доступные команды появятся по мере запуска бота. /start — главное меню.',

  newClientNotice: (u: User) =>
    `Новый клиент: #${u.id} ${escapeHtml(u.displayName)}${u.username ? ` (@${escapeHtml(u.username)})` : ''}`,

  inviteCreated: (link: string, code: string, hours: number) =>
    `Инвайт создан (действует ${hours} ч, одноразовый):\n${escapeHtml(link)}\n\nКод: <code>${escapeHtml(code)}</code>`,
  invitesEmpty: 'Активных инвайтов нет.',
  inviteLine: (code: string, expiresAt: Date, note: string | null) =>
    `<code>${escapeHtml(code)}</code> — до ${expiresAt.toISOString().slice(0, 16).replace('T', ' ')} UTC${note ? ` — ${escapeHtml(note)}` : ''}`,

  clientsEmpty: 'Клиентов пока нет.',
  clientLine: (u: User) =>
    `#${u.id} ${escapeHtml(u.displayName)}${u.username ? ` @${escapeHtml(u.username)}` : ''} — ${
      u.status === 'BLOCKED' ? '🚫 заблокирован' : 'активен'
    }${u.payLaterEnabled ? `, оплата позже: до ${formatRub(u.payLaterLimitMinor)}` : ''}`,
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
};
