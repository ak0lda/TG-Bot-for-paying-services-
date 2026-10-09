import { InlineKeyboard } from 'grammy';
import type { Deps } from '../bot/context.js';
import { debtOf } from '../domain/ledger.js';
import { balancesByClient } from './ledger-service.js';
import { b } from '../texts/balance.js';
import { o as ot } from '../texts/orders.js';

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

/** Планировщик: истечение расчётов (этап 2) и напоминания о долге (этап 3). Подписки/очистка — этап 4. */
export function startScheduler(deps: SchedulerDeps): () => void {
  const sweep = async () => {
    try {
      for (const o of await deps.orders.expireDue()) {
        await deps.presenter.notifyClient(o, ot.expiredNotice(o.id));
      }
      await sendDebtReminders(deps);
    } catch (e) {
      deps.log.error({ err: (e as Error).message }, 'scheduler sweep failed');
    }
  };
  void sweep();
  const timer = setInterval(() => void sweep(), SWEEP_MS);
  return () => clearInterval(timer);
}
