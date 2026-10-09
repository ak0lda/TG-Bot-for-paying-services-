import type { MiddlewareFn } from 'grammy';
import type { BotContext } from '../context.js';
import { RateLimiter } from '../../services/rate-limiter.js';
import { t } from '../../texts/ru.js';

/** 10 запросов подряд, затем 1 в секунду. Лишнее молча отбрасывается (с одним ответом на всплеск). */
export function rateLimit(): MiddlewareFn<BotContext> {
  const limiter = new RateLimiter(10, 1);
  const warned = new Map<string, number>();
  return async (ctx, next) => {
    const id = ctx.from?.id;
    if (id === undefined) return;
    const key = String(id);
    if (limiter.allow(key)) return next();
    const last = warned.get(key) ?? 0;
    if (Date.now() - last > 10_000) {
      warned.set(key, Date.now());
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: t.rateLimited }).catch(() => undefined);
      else await ctx.reply(t.rateLimited).catch(() => undefined);
    }
  };
}
