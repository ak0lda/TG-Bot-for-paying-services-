import { InlineKeyboard } from 'grammy';
import type { Deps } from '../bot/context.js';
import { debtOf } from '../domain/ledger.js';
import { balancesByClient } from './ledger-service.js';
import { b } from '../texts/balance.js';
import { cx } from '../texts/crypto.js';
import { topUpAdminCard } from '../bot/requisites.js';
import { r } from '../texts/reports.js';
import { al, rw } from '../texts/rates.js';
import { readBackupStatus } from './backup-health.js';
import { pingHeartbeat } from './heartbeat.js';
import { o as ot } from '../texts/orders.js';
import { safeError } from '../logging/safe-error.js';

const SWEEP_MS = 5 * 60 * 1000;
const CRYPTO_POLL_MS = 60 * 1000;

type SchedulerDeps = Pick<
  Deps,
  | 'orders'
  | 'presenter'
  | 'log'
  | 'db'
  | 'settings'
  | 'notifier'
  | 'config'
  | 'alerts'
  | 'rates'
  | 'crypto'
  | 'topups'
  | 'catalog'
>;

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
    const renewal = await deps.db.order.findFirst({
      where: { renewedFromId: o.id, status: { notIn: ['CANCELED', 'REJECTED'] } },
    });
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

/**
 * Самодиагностика: свежесть бэкапов и актуальность курсов ЦБ. Оповещения админу (с паузой между повторами),
 * без персональных данных. `startedAt` нужен, чтобы не тревожиться об отсутствии первого бэкапа сразу после запуска.
 */
export async function runHealthChecks(deps: SchedulerDeps, startedAt: Date, now: Date = new Date()): Promise<void> {
  const { BACKUP_DIR, BACKUP_MAX_AGE_HOURS } = deps.config;
  if (BACKUP_DIR) {
    const st = await readBackupStatus(BACKUP_DIR, now, BACKUP_MAX_AGE_HOURS);
    const HALF_DAY = 12 * 3_600_000;
    if (st.state === 'failed')
      await deps.alerts.alert('backup:failed', al.backup.failed(st.ageHours, st.reason), HALF_DAY);
    else if (st.state === 'stale')
      await deps.alerts.alert('backup:stale', al.backup.stale(st.ageHours, BACKUP_MAX_AGE_HOURS), HALF_DAY);
    else if (st.state === 'missing' && now.getTime() - startedAt.getTime() > BACKUP_MAX_AGE_HOURS * 3_600_000) {
      await deps.alerts.alert('backup:missing', al.backup.missing(BACKUP_MAX_AGE_HOURS), HALF_DAY);
    }
  }

  await deps.rates.refresh(); // скачки и недоступность ЦБ замечаются без участия клиентов
  const age = await deps.rates.cbrAgeHours();
  const staleAfter = (await deps.settings.getAll()).rateStaleHours;
  if (age !== null && age > staleAfter)
    await deps.alerts.alert('rates:stale', rw.alertStale(Math.floor(age)), 6 * 3_600_000);
}

/** USDT: опрос сети, привязка переводов к счетам, истечение неоплаченных счетов. Подтверждает зачисление админ. */
export async function processCrypto(deps: SchedulerDeps): Promise<void> {
  if (!deps.crypto.enabled) return;
  try {
    const { matched, unmatched } = await deps.crypto.poll();
    for (const t of matched) {
      await deps.notifier.toClient(t.client.telegramId, cx.seen(t.id));
      const card = await topUpAdminCard(deps, t);
      await deps.notifier.toAdmin(`${cx.adminSeen(t.id)}\n\n${card.text}`, card.kb);
    }
    for (const u of unmatched) {
      await deps.notifier.toAdmin(
        cx.unmatched(u.transfer.amountMicro, u.transfer.txid, u.transfer.from, u.expiredTopUpId),
      );
    }
  } catch (e) {
    deps.log.warn({ ...safeError(e) }, 'crypto poll failed');
    await deps.alerts.alert('crypto:poll', cx.pollFailed, 3 * 3_600_000);
  }
  for (const t of await deps.crypto.expireInvoices()) {
    await deps.notifier.toClient(t.client.telegramId, cx.expired(t.id));
  }
}

/** Планировщик: истечение расчётов, напоминания (долги, подписки), очистка кодов подарочных карт. */
export function startScheduler(deps: SchedulerDeps): () => void {
  const startedAt = new Date();
  const sweep = async () => {
    try {
      for (const o of await deps.orders.expireDue()) {
        await deps.presenter.notifyClient(o, ot.expiredNotice(o.id));
      }
      await sendDebtReminders(deps);
      await sendSubscriptionReminders(deps);
      const purged = await purgeGiftCodes(deps);
      if (purged > 0) deps.log.info({ purged }, 'gift codes purged');
      await runHealthChecks(deps, startedAt);
      await processCrypto(deps);
      // Пульс только после успешного прохода: если планировщик ломается, внешний мониторинг заметит тишину.
      await pingHeartbeat(deps.config.HEARTBEAT_URL, deps.log);
    } catch (e) {
      deps.log.error({ ...safeError(e) }, 'scheduler sweep failed');
      void deps.alerts.error(`scheduler:${safeError(e).err}`, 'Сбой планировщика (напоминания, истечение расчётов)', e);
    }
  };
  void sweep();
  const timer = setInterval(() => void sweep(), SWEEP_MS);
  // Крипто-платежи проверяем чаще: клиент ждёт ответа бота после перевода.
  const cryptoTimer = setInterval(() => void processCrypto(deps).catch(() => undefined), CRYPTO_POLL_MS);
  return () => {
    clearInterval(timer);
    clearInterval(cryptoTimer);
  };
}
