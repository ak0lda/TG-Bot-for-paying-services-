import type { Logger } from '../logger.js';
import { safeError } from '../logging/safe-error.js';

interface AdminNotifier {
  toAdmin(text: string): Promise<boolean>;
}

/**
 * Служебные оповещения админу (сбои, устаревшие бэкапы, скачки курса).
 * Повтор с тем же ключом не чаще раза в `cooldownMs` — чтобы цикл ошибок не завалил чат.
 * Тексты не должны содержать персональных данных: передавайте только результат safeError() и технические поля.
 */
export class AlertService {
  private lastSent = new Map<string, number>();

  constructor(
    private readonly notifier: AdminNotifier,
    private readonly log: Logger,
    private readonly cooldownMs = 60 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  async alert(key: string, text: string, cooldownMs = this.cooldownMs): Promise<boolean> {
    const t = this.now();
    const prev = this.lastSent.get(key);
    if (prev !== undefined && t - prev < cooldownMs) return false;
    this.lastSent.set(key, t);
    if (this.lastSent.size > 500) for (const [k, v] of this.lastSent) if (t - v > 24 * 3_600_000) this.lastSent.delete(k);
    try {
      return await this.notifier.toAdmin(text);
    } catch (e) {
      this.log.warn(safeError(e), 'alert delivery failed');
      return false;
    }
  }

  /** Ошибка с безопасным описанием. */
  error(key: string, title: string, e: unknown, extra = ''): Promise<boolean> {
    return this.alert(key, `⚠️ ${title}\n${safeError(e).err}${extra ? `\n${extra}` : ''}`);
  }
}
