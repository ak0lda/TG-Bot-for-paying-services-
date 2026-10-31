import type { Logger } from '../logger.js';
import { safeError } from '../logging/safe-error.js';

/**
 * «Пульс» для внешнего мониторинга (dead man's switch): если вызовы прекращаются — внешний сервис сам пишет вам,
 * даже когда упал весь сервер и бот молчит. URL содержит секретный токен, поэтому в логи он не попадает никогда.
 */
export async function pingHeartbeat(
  url: string | undefined,
  log: Pick<Logger, 'warn'>,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  if (!url) return false;
  try {
    const res = await fetchFn(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
    if (!res.ok) log.warn({ status: res.status }, 'heartbeat ping rejected');
    return res.ok;
  } catch (e) {
    log.warn(safeError(e), 'heartbeat ping failed');
    return false;
  }
}
