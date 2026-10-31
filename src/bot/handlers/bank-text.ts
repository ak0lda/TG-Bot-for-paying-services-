import { Composer, InlineKeyboard } from 'grammy';
import type { BotContext, Deps } from '../context.js';
import { handleOrderError } from '../errors.js';
import { parseBankNotification } from '../../domain/bank-notification.js';
import { matchAmount, openObligations } from '../../services/payment-matcher.js';
import { o as ot } from '../../texts/orders.js';
import { bank } from '../../texts/bank.js';

const html = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };
const MAX_AMOUNTS = 3;

/**
 * Админ пересылает боту уведомление банка (SMS/push). Бот находит ожидающие оплаты заявки и пополнения на такую же сумму
 * и ПРЕДЛАГАЕТ подтвердить — деньги зачисляются только нажатием админа. Текст уведомления нигде не сохраняется и не логируется.
 * Возвращает true, если сообщение распознано как уведомление (и обработано).
 */
export async function handleBankText(ctx: BotContext, deps: Deps, text: string): Promise<boolean> {
  const parsed = parseBankNotification(text);
  if (parsed.length === 0) return false;

  const candidates = parsed.filter((p) => p.incoming !== false);
  if (candidates.length === 0) {
    await ctx.reply(bank.outgoing);
    return true;
  }
  const rub = candidates.filter((p) => p.currency === 'RUB').slice(0, MAX_AMOUNTS);
  if (rub.length === 0) {
    await ctx.reply(
      bank.nonRub(candidates.map((p) => `${Number(p.amountMinor) / 100} ${p.currency}`).join(', ')),
      html,
    );
    return true;
  }

  const obligations = await openObligations(deps.db);
  for (const p of rub) {
    const unknownDir = p.incoming === null;
    const matches = matchAmount(obligations, p.amountMinor);
    if (matches.length === 0) {
      await ctx.reply(bank.noMatch(p.amountMinor, obligations), html);
      continue;
    }
    const kb = new InlineKeyboard();
    for (const m of matches.slice(0, 6)) {
      kb.text(bank.confirmBtn(m), m.kind === 'order' ? `m:o:${m.id}:${m.version}` : `t:${m.id}:ok`).row();
    }
    await ctx.reply(
      matches.length === 1
        ? bank.matchOne(p.amountMinor, matches[0]!, unknownDir)
        : bank.matchMany(p.amountMinor, matches, unknownDir),
      { ...html, reply_markup: kb },
    );
  }
  return true;
}

/** Кнопка «Подтвердить» под найденной заявкой: m:o:<заявка>:<версия>. Пополнения подтверждаются обычной кнопкой t:<id>:ok. */
export function bankMatchHandlers(deps: Deps): Composer<BotContext> {
  const c = new Composer<BotContext>();
  c.callbackQuery(/^m:o:(\d+):(\d+)$/, async (ctx) => {
    if (ctx.appUser?.role !== 'ADMIN') return void (await ctx.answerCallbackQuery({ text: ot.forbidden }));
    const [id, version] = [Number(ctx.match[1]), Number(ctx.match[2])];
    const order = await deps.orders.get(id);
    if (!order) return void (await ctx.answerCallbackQuery({ text: ot.notFound }));
    if (order.version !== version) {
      await ctx.answerCallbackQuery({ text: bank.stale });
      return void (await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined));
    }
    await ctx.answerCallbackQuery();
    try {
      const done = await deps.orders.confirmPayment(id, version, ctx.appUser.id);
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);
      await deps.notifier.toClient(done.client.telegramId, ot.paymentConfirmed(done.id));
      const view = await deps.presenter.admin(done);
      await ctx.reply(`${bank.confirmed(done.id)}\n\n${view.text}`, { ...html, reply_markup: view.keyboard });
    } catch (e) {
      if (!(await handleOrderError(ctx, deps, e, id))) throw e;
    }
  });
  return c;
}
