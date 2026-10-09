import type { MiddlewareFn } from 'grammy';
import type { BotContext, Deps } from '../context.js';
import { t } from '../../texts/ru.js';

const displayName = (from: { first_name: string; last_name?: string | undefined }) =>
  [from.first_name, from.last_name].filter(Boolean).join(' ');

/**
 * Определяет роль на КАЖДОЕ обновление.
 * - админ: Telegram ID из .env (запись в БД создаётся автоматически);
 * - клиент: запись в БД со статусом ACTIVE;
 * - заблокированный и неизвестный: вежливый отказ. Неизвестному разрешён только /start.
 * Бот работает только в личных чатах.
 */
export function auth(deps: Pick<Deps, 'config' | 'users'>): MiddlewareFn<BotContext> {
  return async (ctx, next) => {
    const from = ctx.from;
    if (!from || ctx.chat?.type !== 'private') return;

    const tgId = BigInt(from.id);
    if (tgId === deps.config.ADMIN_TELEGRAM_ID) {
      ctx.appUser = await deps.users.upsertAdmin({
        id: tgId,
        username: from.username,
        displayName: displayName(from),
      });
      ctx.access = 'ok';
      return next();
    }

    const user = await deps.users.findByTelegramId(tgId);
    if (user?.status === 'ACTIVE') {
      ctx.appUser = user;
      ctx.access = 'ok';
      return next();
    }
    if (user) {
      ctx.access = 'blocked';
      await ctx.reply(t.blocked);
      return;
    }

    ctx.access = 'unknown';
    const isStart = ctx.message?.text?.startsWith('/start') ?? false;
    if (isStart) return next();
    if (ctx.callbackQuery) await ctx.answerCallbackQuery();
    await ctx.reply(t.accessDenied);
  };
}

/** Защита админских хендлеров: проверка роли внутри каждого композера, а не только на входе. */
export const requireAdmin: MiddlewareFn<BotContext> = async (ctx, next) => {
  if (ctx.access === 'ok' && ctx.appUser?.role === 'ADMIN') return next();
  if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: t.adminOnly });
  else await ctx.reply(t.adminOnly);
};
