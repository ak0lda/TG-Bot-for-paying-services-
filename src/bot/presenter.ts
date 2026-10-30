import { InlineKeyboard } from 'grammy';
import type { Order, User } from '@prisma/client';
import type { Deps } from './context.js';
import { orderCb } from './callbacks.js';
import { isTrustedDomain } from '../domain/link-validator.js';
import { formatMinor, formatRub } from '../domain/money.js';
import { formatRate } from '../domain/pricing.js';
import { rateScaledOf, type OrderWithClient } from '../services/order-service.js';
import { LINK_REMINDER, STATUS_EMOJI, STATUS_LABEL, TYPE_LABEL, o as ot, periodLabel } from '../texts/orders.js';
import { escapeHtml } from '../texts/ru.js';

export interface View {
  text: string;
  keyboard: InlineKeyboard;
}

export function formatAge(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ч ${min % 60} мин`;
  return `${Math.floor(h / 24)} д ${h % 24} ч`;
}

const ACTIVE_FOR_STALE = [
  'NEW',
  'QUOTED',
  'AWAITING_PAYMENT',
  'PAYMENT_CHECK',
  'IN_PROGRESS',
  'EXPIRED',
  'LINK_INVALID',
];

export class Presenter {
  constructor(
    private readonly deps: Pick<Deps, 'domains' | 'settings' | 'config' | 'catalog' | 'notifier'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private fmtTime(d: Date): string {
    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: this.deps.config.TIMEZONE,
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(d);
  }

  private amountLine(o: Order): string {
    const amount = o.amountMinor != null ? `${formatMinor(o.amountMinor)} ${o.currency ?? ''}` : '—';
    return o.isSubscription
      ? `${amount} · подписка (${periodLabel(o.periodKind, o.periodDays)})`
      : `${amount} · разовая`;
  }

  private totalLine(o: Order): string | null {
    if (o.totalMinor == null) return null;
    const src = o.rateSource === 'MANUAL' ? 'ручной' : 'ЦБ';
    return `${formatRub(o.totalMinor)} (курс ${formatRate(rateScaledOf(o))}, ${src})`;
  }

  // ── Клиент ────────────────────────────────────────────────
  async client(o: Order): Promise<View> {
    const lines = [
      `<b>Заявка #${o.id}</b> — ${escapeHtml(o.service)}`,
      `Тип: ${TYPE_LABEL[o.type]}`,
      `Статус: ${STATUS_LABEL[o.status]}`,
      `Сумма на сайте: ${this.amountLine(o)}`,
    ];
    const total = this.totalLine(o);
    if (total && !['CANCELED', 'REJECTED'].includes(o.status)) lines.push(`К оплате: <b>${total}</b>`);
    if (o.payMode !== 'PREPAY') lines.push(`Способ оплаты: ${ot.payModeShort[o.payMode]}`);
    if (
      o.payMode === 'BALANCE' &&
      o.reservedMinor > 0n &&
      ['AWAITING_PAYMENT', 'PAYMENT_CHECK', 'IN_PROGRESS'].includes(o.status)
    ) {
      lines.push(`С баланса зарезервировано: ${formatRub(o.reservedMinor)}`);
    }
    if (['QUOTED', 'AWAITING_PAYMENT'].includes(o.status) && o.quoteExpiresAt) {
      lines.push(`Расчёт действует до ${this.fmtTime(o.quoteExpiresAt)}`);
    }
    if (o.status === 'AWAITING_PAYMENT') {
      const due = o.payDueMinor ?? o.totalMinor;
      if (!o.payMethodId) {
        lines.push('', ot.awaitingRequisitesLine);
      } else {
        const m = await this.deps.catalog.getMethod(o.payMethodId);
        if (m && due != null) {
          lines.push(
            '',
            `💳 К оплате: <b>${formatRub(due)}</b>`,
            `Способ: <b>${escapeHtml(m.title)}</b>`,
            ot.requisitesInChat,
            'После перевода нажмите «Я оплатил».',
          );
        }
      }
    }
    if (o.status === 'REJECTED' && o.rejectReason) lines.push(`Причина: ${escapeHtml(o.rejectReason)}`);
    if (o.status === 'LINK_INVALID') lines.push('', LINK_REMINDER);

    const kb = new InlineKeyboard();
    const cb = (a: Parameters<typeof orderCb>[2]) => orderCb(o.id, o.version, a);
    switch (o.status) {
      case 'QUOTED':
        kb.text('✅ Подтвердить и оплатить', cb('cf')).row().text('Отменить', cb('cx'));
        break;
      case 'AWAITING_PAYMENT':
        // «Я оплатил» появляется, когда админ прислал реквизиты.
        if (o.payMethodId) kb.text('💸 Я оплатил', cb('pd')).row();
        kb.text('Отменить', cb('cx'));
        break;
      case 'EXPIRED':
        kb.text('🔄 Пересчитать', cb('rq')).row().text('Отменить', cb('cx'));
        break;
      case 'LINK_INVALID':
        kb.text('🔗 Прислать новую ссылку', cb('nl'));
        break;
      case 'NEW':
      case 'PAYMENT_CHECK':
        kb.text('Отменить', cb('cx'));
        break;
      default:
        break;
    }
    return { text: lines.join('\n'), keyboard: kb };
  }

  // ── Админ ─────────────────────────────────────────────────
  async admin(o: OrderWithClient): Promise<View> {
    const trustedList = await this.deps.domains.list();
    const settings = await this.deps.settings.getAll();
    const c: User = o.client;
    const lines = [
      `<b>${STATUS_EMOJI[o.status]} Заявка #${o.id} — ${TYPE_LABEL[o.type]}</b>`,
      `Клиент: #${c.id} ${escapeHtml(c.displayName)}${c.username ? ` (@${escapeHtml(c.username)})` : ''}`,
      `<b>Сервис: ${escapeHtml(o.service)}</b>`,
    ];
    if (o.type === 'GIFT_CARD' && o.giftRegion) lines.push(`Регион: ${escapeHtml(o.giftRegion)}`);
    if (o.description) lines.push(`Описание: ${escapeHtml(o.description)}`);
    lines.push(`<b>Сумма: ${this.amountLine(o)}</b>`);
    let payLine = `Оплата клиента: <b>${ot.payModeShort[o.payMode]}</b>`;
    if (o.payMode === 'BALANCE' && o.status !== 'NEW' && o.status !== 'QUOTED') {
      payLine += `, с баланса ${formatRub(o.reservedMinor)}${o.payDueMinor ? `, переводом ${formatRub(o.payDueMinor)}` : ''}`;
    }
    if (o.payMode === 'PAY_LATER')
      payLine += ` (клиент платит после выполнения; лимит ${formatRub(c.payLaterLimitMinor)})`;
    lines.push(payLine);
    const total = this.totalLine(o);
    if (total) lines.push(`К оплате клиентом: <b>${total}</b>`);

    if (o.url && o.urlDomain) {
      const trusted = isTrustedDomain(o.urlDomain, trustedList);
      lines.push(
        trusted
          ? `✅ <b>Доверенный домен:</b> ${escapeHtml(o.urlDomain)}`
          : `⚠️ <b>НЕИЗВЕСТНЫЙ ДОМЕН — проверь перед вводом карты:</b> ${escapeHtml(o.urlDomain)}`,
      );
    }
    const ageMs = this.now().getTime() - o.createdAt.getTime();
    let age = `Возраст заявки: ${formatAge(ageMs)}`;
    if (o.url && ACTIVE_FOR_STALE.includes(o.status) && ageMs > settings.staleLinkHours * 3_600_000) {
      age += ' — ⏳ ссылка может быть недействительна';
    }
    lines.push(age);
    lines.push(`Статус: ${STATUS_LABEL[o.status]}`);
    if (o.status === 'AWAITING_PAYMENT') {
      const m = o.payMethodId ? await this.deps.catalog.getMethod(o.payMethodId) : null;
      lines.push(
        m ? `📤 Реквизиты отправлены: ${escapeHtml(m.title)}` : '⏳ Реквизиты клиенту не отправлены — выбери способ',
      );
    }
    if (o.comment) lines.push(`Комментарий: ${escapeHtml(o.comment)}`);
    if (o.rejectReason) lines.push(`Причина отклонения: ${escapeHtml(o.rejectReason)}`);
    if (o.status === 'DONE' && o.diffMinor != null) {
      lines.push(`Разница по факту: ${formatRub(o.diffMinor)}`);
    }

    const kb = new InlineKeyboard();
    const cb = (a: Parameters<typeof orderCb>[2]) => orderCb(o.id, o.version, a);
    switch (o.status) {
      case 'AWAITING_PAYMENT': {
        // Способ перевода выбирает админ: кнопка на каждый активный способ (повторное нажатие — отправить реквизиты снова).
        for (const m of await this.deps.catalog.listMethods(true))
          kb.text(ot.requisitesBtn(m.title), `r:${o.id}:${o.version}:${m.id}`).row();
        break;
      }
      case 'NEW':
        kb.text('🧮 Рассчитать', cb('q'));
        break;
      case 'EXPIRED':
        kb.text('🔄 Пересчитать', cb('rq'));
        break;
      case 'PAYMENT_CHECK':
        kb.text('✅ Оплата получена', cb('pc')).text('🚫 Оплата не найдена', cb('pn'));
        break;
      case 'IN_PROGRESS':
        if (o.url) kb.url('🔗 Открыть ссылку', o.url).row();
        kb.text('✅ Выполнено', cb('dn')).text('⛓ Ссылка не работает', cb('lk'));
        break;
      default:
        break;
    }
    if (!['DONE', 'CANCELED', 'REJECTED'].includes(o.status)) kb.row().text('❌ Отклонить', cb('rj'));
    return { text: lines.join('\n'), keyboard: kb };
  }

  async notifyAdmin(o: OrderWithClient, intro?: string): Promise<void> {
    const v = await this.admin(o);
    await this.deps.notifier.toAdmin(intro ? `${intro}\n\n${v.text}` : v.text, v.keyboard);
  }

  async notifyClient(o: OrderWithClient, intro?: string): Promise<void> {
    const v = await this.client(o);
    await this.deps.notifier.toClient(o.client.telegramId, intro ? `${intro}\n\n${v.text}` : v.text, v.keyboard);
  }

  /** Список заявок кнопками (для «Мои заявки» и /orders). */
  list(orders: Array<Order>, withClient = false): InlineKeyboard {
    const kb = new InlineKeyboard();
    for (const o of orders) {
      const who = withClient ? ` · #${(o as OrderWithClient).client?.id ?? ''}` : '';
      kb.text(
        `${STATUS_EMOJI[o.status]} #${o.id} · ${o.service.slice(0, 24)}${who}`,
        orderCb(o.id, o.version, 'v'),
      ).row();
    }
    return kb;
  }
}
