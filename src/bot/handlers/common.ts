import { Composer } from 'grammy';
import type { BotContext, Deps } from '../context.js';
import { t } from '../../texts/ru.js';

const html = { parse_mode: 'HTML' as const };

export function commonHandlers(deps: Deps): Composer<BotContext> {
  const c = new Composer<BotContext>();

  c.command('start', async (ctx) => {
    const payload = ctx.match.trim();

    if (ctx.access === 'ok' && ctx.appUser) {
      const user = ctx.appUser;
      await ctx.reply(user.role === 'ADMIN' ? t.welcomeAdmin : t.welcomeClient(user.displayName), html);
      return;
    }

    // access === 'unknown'
    if (!payload) {
      await ctx.reply(t.accessDenied);
      return;
    }
    const from = ctx.from!;
    const res = await deps.invites.redeem(payload, {
      id: BigInt(from.id),
      username: from.username,
      displayName: [from.first_name, from.last_name].filter(Boolean).join(' '),
    });
    if (!res.ok) {
      await ctx.reply(t.inviteInvalid);
      return;
    }
    deps.log.info({ userId: res.user.id }, 'client registered via invite');
    await ctx.reply(t.welcomeClient(res.user.displayName), html);
    const adminChat = deps.config.ADMIN_CHAT_ID ?? deps.config.ADMIN_TELEGRAM_ID;
    await ctx.api
      .sendMessage(Number(adminChat), t.newClientNotice(res.user), html)
      .catch((e: unknown) => deps.log.warn({ err: (e as Error).message }, 'admin notify failed'));
  });

  c.command('help', async (ctx) => {
    await ctx.reply(ctx.appUser?.role === 'ADMIN' ? t.welcomeAdmin : t.helpClient, html);
  });

  return c;
}
