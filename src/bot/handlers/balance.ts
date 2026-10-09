import { Composer, InlineKeyboard } from 'grammy';
import type { BotContext, Deps } from '../context.js';
import { startTopUp } from '../wizard/topup-flow.js';
import { debtOf } from '../../domain/ledger.js';
import { balanceOf, ledgerHistory } from '../../services/ledger-service.js';
import { b } from '../../texts/balance.js';
import { o as ot } from '../../texts/orders.js';

const html = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };

export function balanceHandlers(deps: Deps): Composer<BotContext> {
  const c = new Composer<BotContext>();

  const clientOnly = async (ctx: BotContext): Promise<boolean> => {
    if (ctx.access === 'ok' && ctx.appUser?.role === 'CLIENT') return true;
    await ctx.reply(ot.menuHint);
    return false;
  };

  // ── Клиент: баланс и пополнение ───────────────────────────
  c.hears(b.btnBalance, async (ctx) => {
    if (!(await clientOnly(ctx))) return;
    const id = ctx.appUser!.id;
    const balance = await balanceOf(deps.db, id);
    const kb = new InlineKeyboard().text(b.topUpBtn, 'b:top');
    if (balance < 0n) kb.row().text(b.repayBtn(debtOf(balance)), 'b:debt');
    await ctx.reply(
      b.screen({
        balance,
        pending: await deps.topups.pendingCount(id),
        entries: await ledgerHistory(deps.db, id, 10),
        tz: deps.config.TIMEZONE,
      }),
      { ...html, reply_markup: kb },
    );
  });

  c.hears(b.btnTopUp, async (ctx) => {
    if (await clientOnly(ctx)) await startTopUp(ctx, deps);
  });

  c.callbackQuery(/^b:(top|debt)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (ctx.appUser?.role !== 'CLIENT') return;
    await startTopUp(ctx, deps, { repayDebt: ctx.match[1] === 'debt' });
  });

  // ── Админ: подтверждение пополнений ───────────────────────
  c.callbackQuery(/^t:(\d+):(ok|no)$/, async (ctx) => {
    if (ctx.appUser?.role !== 'ADMIN') return void (await ctx.answerCallbackQuery({ text: ot.forbidden }));
    const id = Number(ctx.match[1]);
    const approve = ctx.match[2] === 'ok';
    const strip = () => ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);

    if (approve) {
      const res = await deps.topups.confirm(id, ctx.appUser.id);
      if (!res) {
        await ctx.answerCallbackQuery({ text: b.topUpAlready });
        return void (await strip());
      }
      await ctx.answerCallbackQuery();
      await strip();
      await ctx.reply(b.topUpDone(id, res.balanceMinor));
      await deps.notifier.toClient(res.topUp.client.telegramId, b.topUpConfirmed(res.topUp.amountMinor, res.balanceMinor));
      return;
    }
    const rejected = await deps.topups.reject(id, ctx.appUser.id);
    if (!rejected) {
      await ctx.answerCallbackQuery({ text: b.topUpAlready });
      return void (await strip());
    }
    await ctx.answerCallbackQuery();
    await strip();
    await ctx.reply(b.topUpDeclined(id));
    await deps.notifier.toClient(rejected.client.telegramId, b.topUpRejected(id));
  });

  return c;
}
