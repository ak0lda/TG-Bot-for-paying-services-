import type { RateWarning } from '../domain/rate-check.js';
import { formatRate } from '../domain/pricing.js';

const pct = (bp: number) => `${(bp / 100).toFixed(bp % 100 === 0 ? 0 : 1).replace('.', ',')}%`;

export function warningText(w: RateWarning, currency: string): string {
  switch (w.kind) {
    case 'stale':
      return `⏳ Курс ЦБ по ${currency} не обновлялся ${w.ageHours} ч — ЦБ недоступен, расчёт пойдёт по устаревшему курсу.`;
    case 'jump':
      return `📈 Курс ${currency} резко изменился на ${pct(w.changeBp)}: с ${formatRate(w.fromScaled)} до ${formatRate(w.toScaled)} ₽ — проверь, что расчёт не устарел.`;
    case 'manual_old':
      return `✋ Ручной курс ${currency} (${formatRate(w.scaled)} ₽) задан ${w.ageDays} дн. назад и всё ещё перекрывает ЦБ.`;
    case 'manual_diverged':
      return `✋ Ручной курс ${currency} (${formatRate(w.manualScaled)} ₽) расходится с курсом ЦБ (${formatRate(w.cbrScaled)} ₽) на ${pct(w.changeBp)}.`;
  }
}

export const rw = {
  title: (currency: string, orderId: number) =>
    `⚠️ Прежде чем рассчитать заявку #${orderId} (${currency}), обрати внимание:`,
  confirmBtn: 'Рассчитать всё равно',
  cancelBtn: 'Отмена',
  note: (n: number) => `⚠️ Расчёт сделан при предупреждениях по курсу (${n}).`,
  alertJump: (currency: string, w: Extract<RateWarning, { kind: 'jump' }>) =>
    `📈 Курс ЦБ ${currency} изменился на ${pct(w.changeBp)}: с ${formatRate(w.fromScaled)} до ${formatRate(w.toScaled)} ₽. Новые расчёты пойдут по новому курсу; открытые расчёты (до подтверждения клиентом) стоит пересчитать.`,
  alertStale: (hours: number) =>
    `⏳ Курс ЦБ не обновлялся ${hours} ч (ЦБ недоступен?). Расчёты идут по последнему известному курсу — при необходимости задай курс вручную: /rate USD 95,5`,
};

export const al = {
  boot: (mode: string) =>
    `🔄 Бот запущен (режим ${mode}). Если вы не перезапускали его сами, проверьте логи: возможен перезапуск после сбоя.`,
  fatal: (what: string) => `🛑 Критическая ошибка, процесс перезапускается: ${what}`,
  backup: {
    stale: (h: number, max: number) =>
      `💾 Последний успешный бэкап БД был ${h} ч назад (порог ${max} ч). Проверьте контейнер backup и свободное место.`,
    failed: (h: number, reason: string) => `💾 Последний бэкап БД завершился ошибкой (${h} ч назад): ${reason}`,
    missing: (max: number) =>
      `💾 Бэкапов БД нет уже более ${max} ч после запуска бота. Проверьте контейнер backup (docker compose logs backup).`,
  },
};
