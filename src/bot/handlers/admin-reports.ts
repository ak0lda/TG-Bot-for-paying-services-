import { Composer, InlineKeyboard, InputFile } from 'grammy';
import type { BotContext, Deps } from '../context.js';
import { requireAdmin } from '../middleware/auth.js';
import { parseRange } from '../../domain/range.js';
import { formatUsdt } from '../../domain/crypto-invoice.js';
import { cx } from '../../texts/crypto.js';
import { o as ot } from '../../texts/orders.js';
import { fx as fxt, r } from '../../texts/reports.js';

const html = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };
const ADMIN_COMMANDS = ['stats', 'export', 'subs', 'fx', 'crypto'];

export function adminReportHandlers(deps: Deps): Composer<BotContext> {
  const outer = new Composer<BotContext>();
  const c = new Composer<BotContext>();
  const tz = deps.config.TIMEZONE;

  c.command('stats', async (ctx) => {
    const range = parseRange(ctx.match, new Date(), tz);
    if (!range) return void (await ctx.reply(`${r.badPeriod}\n\n${r.periodUsage}`, html));
    const rep = await deps.reports.stats(range);
    await ctx.reply(
      r.stats({
        label: range.label,
        stats: rep.stats,
        created: rep.createdByStatus,
        topUp: rep.topUpMinor,
        repaid: rep.repaidMinor,
      }),
      html,
    );
  });

  c.command('export', async (ctx) => {
    const range = parseRange(ctx.match, new Date(), tz);
    if (!range) return void (await ctx.reply(`${r.badPeriod}\n\n${r.periodUsage}`, html));
    const [orders, ledger] = await Promise.all([deps.reports.ordersCsv(range), deps.reports.ledgerCsv(range)]);
    if (orders.rows === 0 && ledger.rows === 0) return void (await ctx.reply(r.exportEmpty));
    const stamp = (ctx.match.trim() || 'month').toLowerCase().replace(/[^0-9a-z-]+/g, '_');
    // BOM — чтобы Excel правильно распознал UTF-8.
    const file = (csv: string, name: string) => new InputFile(Buffer.from(`﻿${csv}`, 'utf8'), name);
    await ctx.replyWithDocument(file(orders.csv, `orders_${stamp}.csv`), {
      caption: r.exportCaption('Заявки', range.label, orders.rows),
    });
    await ctx.replyWithDocument(file(ledger.csv, `ledger_${stamp}.csv`), {
      caption: r.exportCaption('Операции баланса', range.label, ledger.rows),
    });
  });

  c.command('subs', async (ctx) => {
    const subs = await deps.orders.listSubscriptions();
    if (subs.length === 0) return void (await ctx.reply(r.subsEmpty));
    await ctx.reply([r.subsTitle, ...subs.map((s) => r.subLine(s, tz))].join('\n'), html);
  });

  c.command('crypto', async (ctx) => {
    if (!deps.crypto.enabled) return void (await ctx.reply(cx.statusOff));
    const pending = await deps.db.topUp.count({ where: { kind: 'USDT_TRC20', status: 'PENDING' } });
    const last = await deps.db.cryptoTransfer.findFirst({ orderBy: { blockTimestamp: 'desc' } });
    await ctx.reply(
      cx.status({
        address: deps.crypto.address,
        pending,
        lastSeen: last
          ? `${formatUsdt(last.amountMicro)} USDT, ${last.blockTimestamp.toISOString().slice(0, 16)}Z`
          : null,
      }),
      html,
    );
  });

  c.command('fx', async (ctx) => {
    const raw = ctx.match.trim();
    const days = raw === '' ? 60 : /^\d{1,3}$/.test(raw) ? Number(raw) : NaN;
    if (!(days >= 7 && days <= 365)) return void (await ctx.reply(fxt.usage));
    const advice = await deps.reports.fxAdvice(days);
    const kb = new InlineKeyboard();
    if (advice.overall.enough && advice.overall.recommendedBp !== advice.overall.currentBp) {
      kb.text(fxt.apply(advice.overall.recommendedBp), `fx:${advice.overall.recommendedBp}`);
    }
    await ctx.reply(fxt.report(days, advice.overall, advice.byCurrency), { ...html, reply_markup: kb });
  });

  outer.command(ADMIN_COMMANDS, requireAdmin, c);

  // Явное применение рекомендации — только админ, одним нажатием (запас меняется для новых расчётов).
  outer.callbackQuery(/^fx:(\d{1,4})$/, async (ctx) => {
    if (ctx.appUser?.role !== 'ADMIN') return void (await ctx.answerCallbackQuery({ text: ot.forbidden }));
    const bp = Number(ctx.match[1]);
    if (bp > 1000) return void (await ctx.answerCallbackQuery({ text: ot.invalidAction }));
    await deps.settings.set('fxBufferBp', bp);
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => undefined);
    await ctx.reply(fxt.applied(bp));
  });
  return outer;
}
