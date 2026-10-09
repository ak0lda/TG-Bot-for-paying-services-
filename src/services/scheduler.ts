import type { Deps } from '../bot/context.js';
import { o as ot } from '../texts/orders.js';

const SWEEP_MS = 5 * 60 * 1000;

/** Минимальный планировщик этапа 2: истечение расчётов. Напоминания и очистка — этап 4. */
export function startScheduler(deps: Pick<Deps, 'orders' | 'presenter' | 'log'>): () => void {
  const sweep = async () => {
    try {
      for (const o of await deps.orders.expireDue()) {
        await deps.presenter.notifyClient(o, ot.expiredNotice(o.id));
      }
    } catch (e) {
      deps.log.error({ err: (e as Error).message }, 'expire sweep failed');
    }
  };
  void sweep();
  const timer = setInterval(() => void sweep(), SWEEP_MS);
  return () => clearInterval(timer);
}
