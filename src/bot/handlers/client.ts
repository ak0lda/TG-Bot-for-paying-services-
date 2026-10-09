import { Composer } from 'grammy';
import type { BotContext, Deps } from '../context.js';
import { buildClientMenu } from '../keyboards/menu.js';
import { orderWizard } from '../wizard/order-wizard.js';
import { o as ot } from '../../texts/orders.js';

export function clientHandlers(deps: Deps): Composer<BotContext> {
  const c = new Composer<BotContext>();

  const clientOnly = async (ctx: BotContext): Promise<boolean> => {
    if (ctx.access === 'ok' && ctx.appUser?.role === 'CLIENT') return true;
    await ctx.reply(ot.menuHint);
    return false;
  };

  c.hears(ot.btnNew, async (ctx) => {
    if (!(await clientOnly(ctx))) return;
    deps.wizards.cancel(ctx.from!.id);
    await deps.wizards.start(ctx, orderWizard(deps), { clientId: ctx.appUser!.id });
  });

  c.hears(ot.btnMy, async (ctx) => {
    if (!(await clientOnly(ctx))) return;
    const orders = await deps.orders.listForClient(ctx.appUser!.id);
    if (orders.length === 0) return void (await ctx.reply(ot.noOrders, { reply_markup: buildClientMenu(deps.config.WEBAPP_URL) }));
    await ctx.reply(ot.myOrdersTitle, { reply_markup: deps.presenter.list(orders) });
  });

  c.command('cancel', async (ctx) => {
    const had = deps.wizards.cancel(ctx.from!.id);
    await ctx.reply(had ? ot.wizardCanceled : ot.menuHint);
  });

  return c;
}
