import { Composer } from 'grammy';
import type { BotContext, Deps } from '../context.js';
import { t } from '../../texts/ru.js';
import { estimate } from '../../services/calc.js';
import { RateUnavailableError } from '../../services/rates.js';
import { formatMinor, formatRub, parseDecimalToMinor } from '../../domain/money.js';
import { buildClientMenu } from '../keyboards/menu.js';
import { InlineKeyboard } from 'grammy';
import { o as ot } from '../../texts/orders.js';
import { safeError } from '../../logging/safe-error.js';

const html = { parse_mode: 'HTML' as const };

export function commonHandlers(deps: Deps): Composer<BotContext> {
  const c = new Composer<BotContext>();

  c.command('start', async (ctx) => {
    const payload = ctx.match.trim();

    if (ctx.access === 'ok' && ctx.appUser) {
      const user = ctx.appUser;
      if (user.role === 'ADMIN') await ctx.reply(t.welcomeAdmin, html);
      else
        await ctx.reply(t.welcomeClient(user.displayName), {
          ...html,
          reply_markup: buildClientMenu(deps.config.WEBAPP_URL),
        });
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
    await ctx.reply(t.welcomeClient(res.user.displayName), {
      ...html,
      reply_markup: buildClientMenu(deps.config.WEBAPP_URL),
    });
    const adminChat = deps.config.ADMIN_CHAT_ID ?? deps.config.ADMIN_TELEGRAM_ID;
    await ctx.api
      .sendMessage(Number(adminChat), t.newClientNotice(res.user), html)
      .catch((e: unknown) => deps.log.warn({ ...safeError(e) }, 'admin notify failed'));
  });

  c.command('app', async (ctx) => {
    const url = deps.config.WEBAPP_URL;
    if (!url || ctx.access !== 'ok') return void (await ctx.reply(ot.appDisabled));
    await ctx.reply(ot.appOpen, { reply_markup: new InlineKeyboard().webApp(ot.appOpenBtn, url) });
  });

  c.command('calc', async (ctx) => {
    if (ctx.access !== 'ok') return void (await ctx.reply(t.accessDenied));
    const m = /^\s*([\d\s]+(?:[.,]\d{1,2})?)\s*([A-Za-z]{3})?\s*$/.exec(ctx.match);
    if (!m) return void (await ctx.reply(ot.calcUsage));
    const cur = (m[2] ?? 'USD').toUpperCase();
    let amount: bigint;
    try {
      amount = parseDecimalToMinor(m[1]!);
    } catch {
      return void (await ctx.reply(ot.calcUsage));
    }
    if (amount <= 0n || amount > 100_000_000n || cur === 'RUB') return void (await ctx.reply(ot.calcUsage));
    try {
      const e = await estimate(deps, amount, cur);
      await ctx.reply(ot.calcResult(formatMinor(amount), cur, formatRub(e.totalMinor), e.rate), html);
    } catch (e) {
      if (e instanceof RateUnavailableError) return void (await ctx.reply(ot.noRate(cur), html));
      throw e;
    }
  });

  c.command('help', async (ctx) => {
    await ctx.reply(ctx.appUser?.role === 'ADMIN' ? t.welcomeAdmin : t.helpClient, html);
  });

  return c;
}
