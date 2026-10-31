import type { Order, OrderStatus, User } from '@prisma/client';
import type { CardRow, Row, Stats } from '../domain/stats.js';
import { formatMinor, formatRub } from '../domain/money.js';
import { periodLabel } from './orders.js';
import { escapeHtml } from './ru.js';

const fmtDate = (d: Date, tz: string) =>
  new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);

const rows = (list: Row[], limit = 10) =>
  list.slice(0, limit).map((r) => `${escapeHtml(r.label)} — ${formatRub(r.turnoverMinor)} (${r.count})`);

const cardRows = (list: CardRow[]) =>
  list.map(
    (c) =>
      `${escapeHtml(c.label)} — ${formatMinor(c.chargeMinor)} ${c.currency} ≈ ${formatRub(c.rubMinor)} (${c.count})`,
  );

const pctBp = (bp: number): string =>
  `${bp < 0 ? '−' : ''}${(Math.abs(bp) / 100).toFixed(Math.abs(bp) % 100 === 0 ? 0 : Math.abs(bp) % 10 === 0 ? 1 : 2).replace('.', ',')}%`;
const sharePct = (x: number): string => `${Math.round(x * 100)}%`;

export const fx = {
  usage: 'Использование: /fx [дней] — период 7–365 дней (по умолчанию 60).',
  apply: (bp: number) => `Применить ${pctBp(bp)}`,
  applied: (bp: number) => `✅ Запас на конвертацию теперь ${pctBp(bp)}. Действует для новых расчётов.`,
  report: (
    days: number,
    a: {
      sample: number;
      enough: boolean;
      currentBp: number;
      surchargeShare: number;
      medianBp: number;
      p90Bp: number;
      maxBp: number;
      recommendedBp: number;
      recommendedSurchargeShare: number;
    },
    byCurrency: Array<{ currency: string; sample: number; medianBp: number; p90Bp: number }>,
  ) => {
    const head = `📊 <b>Запас на конвертацию</b> — последние ${days} дн., выполнено заявок: ${a.sample}`;
    if (!a.enough) {
      return `${head}\nДанных пока мало (нужно хотя бы 10 выполненных заявок), поэтому рекомендацию не даю. Текущий запас: ${pctBp(a.currentBp)}.`;
    }
    const lines = [
      head,
      `Сейчас запас: <b>${pctBp(a.currentBp)}</b> — клиентам пришлось доплачивать в ${sharePct(a.surchargeShare)} заявок.`,
      `Фактический расход относительно курса расчёта: медиана ${pctBp(a.medianBp)}, у 90% заявок не выше ${pctBp(a.p90Bp)}, максимум ${pctBp(a.maxBp)}.`,
      `Рекомендация: <b>${pctBp(a.recommendedBp)}</b> — доплата понадобится примерно в ${sharePct(a.recommendedSurchargeShare)} заявок.`,
    ];
    if (byCurrency.length > 1) {
      lines.push(
        '',
        '<b>По валюте карты</b> (медиана / 90%)',
        ...byCurrency.map((c) => `${c.currency}: ${pctBp(c.medianBp)} / ${pctBp(c.p90Bp)} (${c.sample})`),
      );
    }
    lines.push(
      '',
      'Запас не меняет вашу прибыль: разница по факту всегда уходит на баланс клиента. Он лишь определяет, насколько итоговая сумма предсказуема для клиента.',
    );
    return lines.join('\n');
  },
};

export const r = {
  periodUsage:
    'Период: <code>month</code> (по умолчанию), <code>prev</code>, <code>week</code>, <code>today</code>, <code>all</code>, <code>2026-09</code>, <code>2026-09-15</code> или <code>2026-09-01 2026-09-30</code>.',
  badPeriod: 'Не понял период. Примеры: /stats month · /stats prev · /stats 2026-09 · /stats 2026-09-01 2026-09-30',

  stats: (p: {
    label: string;
    stats: Stats;
    created: Partial<Record<OrderStatus, number>>;
    topUp: bigint;
    repaid: bigint;
  }) => {
    const { stats: s } = p;
    const created = Object.values(p.created).reduce((a, b) => a + (b ?? 0), 0);
    const lines = [
      `<b>Статистика — ${escapeHtml(p.label)}</b>`,
      `Создано заявок: ${created}${created ? ` (выполнено ${p.created.DONE ?? 0}, отклонено ${p.created.REJECTED ?? 0}, отменено ${p.created.CANCELED ?? 0}, в процессе ${created - (p.created.DONE ?? 0) - (p.created.REJECTED ?? 0) - (p.created.CANCELED ?? 0)})` : ''}`,
      `Выполнено в периоде: <b>${s.count}</b>`,
      `Оборот (выставлено клиентам): <b>${formatRub(s.turnoverMinor)}</b>`,
      `Фактические расходы: ${formatRub(s.costMinor)}`,
      `Валовая прибыль: <b>${formatRub(s.profitMinor)}</b>`,
      `Пополнения балансов: ${formatRub(p.topUp)} · погашено долгов: ${formatRub(p.repaid)}`,
    ];
    if (s.count > 0) {
      lines.push(
        '',
        '<b>По клиентам</b>',
        ...rows(s.byClient),
        '',
        '<b>По сервисам</b>',
        ...rows(s.byService),
        '',
        '<b>По картам</b> (списано в валюте карты ≈ в ₽)',
        ...cardRows(s.byCard),
      );
    }
    return lines.join('\n');
  },

  exportEmpty: 'За этот период данных нет.',
  exportCaption: (what: string, label: string, n: number) => `${what} — ${label} (${n} строк)`,

  // ── Подписки ──
  subsEmpty: 'Активных подписок нет.',
  subLine: (o: Order & { client: User }, tz: string) =>
    `#${o.id} ${escapeHtml(o.service)} — ${o.client.displayName ? escapeHtml(o.client.displayName) : `клиент #${o.clientId}`} (#${o.clientId}) · ${periodLabel(o.periodKind, o.periodDays)} · следующее списание ${o.nextChargeAt ? fmtDate(o.nextChargeAt, tz) : '—'}`,
  subsTitle: '<b>Подписки</b> (ближайшие списания первыми)',

  subReminderClient: (o: Order, tz: string) =>
    `🔁 Подписка «${escapeHtml(o.service)}» (заявка #${o.id}) продлевается <b>${fmtDate(o.nextChargeAt!, tz)}</b>.\nПродлить? Я создам новую заявку с теми же данными${o.url ? ' — понадобится свежая ссылка на оплату' : ''}.`,
  subReminderAdmin: (o: Order & { client: User }, tz: string) =>
    `🔁 Скоро списание по подписке #${o.id} «${escapeHtml(o.service)}» (клиент #${o.clientId} ${escapeHtml(o.client.displayName)}): ${fmtDate(o.nextChargeAt!, tz)}.`,
  renewBtn: '🔁 Продлить',
  stopBtn: 'Не продлевать',
  renewStarted: 'Оформляю продление.',
  renewExists: (id: number) => `Продление уже оформлено — заявка #${id}.`,
  renewCreated: (id: number, src: number) => `Создана заявка #${id} (продление #${src}). Админ скоро рассчитает сумму.`,
  adminRenewal: (src: number) => `🔁 Продление подписки #${src}`,
  renewNotAllowed: 'Эту подписку продлить нельзя.',
  stopped: (id: number) => `Хорошо, подписку по заявке #${id} больше не напоминаю.`,
  stoppedAdmin: (id: number, clientId: number) => `Клиент #${clientId} отказался от продления подписки #${id}.`,
  alreadyStopped: 'Уже обработано.',
};
