import { Composer, InputFile } from 'grammy';
import type { BotContext, Deps } from '../context.js';
import { requireAdmin } from '../middleware/auth.js';
import { parseRange } from '../../domain/range.js';
import { r } from '../../texts/reports.js';

const html = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };
const ADMIN_COMMANDS = ['stats', 'export', 'subs'];

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

  outer.command(ADMIN_COMMANDS, requireAdmin, c);
  return outer;
}
