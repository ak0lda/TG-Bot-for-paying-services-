import { InlineKeyboard } from 'grammy';
import type { Deps } from '../bot/context.js';
import { debtOf } from '../domain/ledger.js';
import { balancesByClient } from './ledger-service.js';
import { b } from '../texts/balance.js';
import { r } from '../texts/reports.js';
import { o as ot } from '../texts/orders.js';
import { safeError } from '../logging/safe-error.js';

const SWEEP_MS = 5 * 60 * 1000;

type SchedulerDeps = Pick<Deps, 'orders' | 'presenter' | 'log' | 'db' | 'settings' | 'notifier' | 'config'>;

const localHour = (now: Date, tz: string): number =>
  Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(now)) % 24;

/**
 * Напоминания о долге: раз в `debtReminderDays` дней, не раньше `reminderHour` по TIMEZONE.
 * Дедупликация через таблицу Reminder (ключ = клиент + номер периода), поэтому перезапуски и частый опрос безопасны.
 */
export async function sendDebtReminders(deps: SchedulerDeps, now: Date = new Date()): Promise<number> {
  const settings = await deps.settings.getAll();
  if (localHour(now, deps.config.TIMEZONE) < settings.reminderHour) return 0;
  const period = Math.floor(now.getTime() / 86_400_000 / settings.debtReminderDays);

  let sent = 0;
  for (const [clientId, balance] of await balancesByClient(deps.db)) {
    const debt = debtOf(balance);
    if (debt === 0n) continue;
    const client = await deps.db.user.findFirst({ where: { id: clientId, role: 'CLIENT', status: 'ACTIVE' } });
    if (!client) continue;
    try {
      await deps.db.reminder.create({ data: { key: `debt:${clientId}:${period}` } });
    } catch {
      continue; // уже отправляли в этом периоде (unique)
    }
    const kb = new InlineKeyboard().text(b.repayBtn(debt), 'b:debt');
    if (await deps.notifier.toClient(client.telegramId, b.debtReminder(debt), kb)) sent++;
  }
  return sent;
}

/**
 * Напоминания о подписках: за `subscriptionRemindDays` дней до списания (и до 3 дней после, если пропустили) —
 * клиенту с кнопками «Продлить» / «Не продлевать» и админу. Один раз на (заявка, дата списания).
 * Не напоминаем, если продление уже оформлено или клиент заблокирован.
 */
export async function sendSubscriptionReminders(deps: SchedulerDeps, now: Date = new Date()): Promise<number> {
  const settings = await deps.settings.getAll();
  if (localHour(now, deps.config.TIMEZONE) < settings.reminderHour) return 0;
  const horizon = new Date(now.getTime() + settings.subscriptionRemindDays * 86_400_000);
  const grace = new Date(now.getTime() - 3 * 86_400_000);

  const subs = await deps.db.order.findMany({
    where: { isSubscription: true, status: 'DONE', nextChargeAt: { not: null, lte: horizon, gte: grace } },
    include: { client: true },
    orderBy: { nextChargeAt: 'asc' },
  });

  let sent = 0;
  for (const o of subs) {
    if (o.client.status !== 'ACTIVE') continue;
    const renewal = await deps.db.order.findFirst({ where: { renewedFromId: o.id, status: { notIn: ['CANCELED', 'REJECTED'] } } });
    if (renewal) continue;
    try {
      await deps.db.reminder.create({ data: { key: `sub:${o.id}:${o.nextChargeAt!.toISOString().slice(0, 10)}` } });
    } catch {
      continue; // уже напоминали об этом списании
    }
    const kb = new InlineKeyboard().text(r.renewBtn, `s:${o.id}:rn`).text(r.stopBtn, `s:${o.id}:no`);
    if (await deps.notifier.toClient(o.client.telegramId, r.subReminderClient(o, deps.config.TIMEZONE), kb)) sent++;
    await deps.notifier.toAdmin(r.subReminderAdmin(o, deps.config.TIMEZONE));
  }
  return sent;
}

/** Автоудаление кодов подарочных карт: после `giftCodeDeleteAt` шифртекст стирается из БД. */
export async function purgeGiftCodes(deps: Pick<SchedulerDeps, 'db'>, now: Date = new Date()): Promise<number> {
  const res = await deps.db.order.updateMany({
    where: { giftCodeEnc: { not: null }, giftCodeDeleteAt: { lte: now } },
    data: { giftCodeEnc: null, giftCodeDeleteAt: null },
  });
  return res.count;
}

/** Планировщик: истечение расчётов, напоминания (долги, подписки), очистка кодов подарочных карт. */
export function startScheduler(deps: SchedulerDeps): () => void {
  const sweep = async () => {
    try {
      for (const o of await deps.orders.expireDue()) {
        await deps.presenter.notifyClient(o, ot.expiredNotice(o.id));
      }
      await sendDebtReminders(deps);
      await sendSubscriptionReminders(deps);
      const purged = await purgeGiftCodes(deps);
      if (purged > 0) deps.log.info({ purged }, 'gift codes purged');
    } catch (e) {
      deps.log.error({ ...safeError(e) }, 'scheduler sweep failed');
    }
  };
  void sweep();
  const timer = setInterval(() => void sweep(), SWEEP_MS);
  return () => clearInterval(timer);
}
