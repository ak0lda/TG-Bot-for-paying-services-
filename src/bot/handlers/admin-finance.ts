import { Composer } from 'grammy';
import type { BotContext, Deps } from '../context.js';
import { requireAdmin } from '../middleware/auth.js';
import { MoneyParseError, parseDecimalToMinor } from '../../domain/money.js';
import { balanceOf, balancesByClient, ledgerHistory } from '../../services/ledger-service.js';
import { b } from '../../texts/balance.js';
import { t } from '../../texts/ru.js';

const html = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };
const ADMIN_COMMANDS = ['debts', 'adjust', 'client'];
const parseId = (s: string): number | null => (/^\d{1,9}$/.test(s) ? Number(s) : null);

export function adminFinanceHandlers(deps: Deps): Composer<BotContext> {
  const outer = new Composer<BotContext>();
  const c = new Composer<BotContext>();

  c.command('debts', async (ctx) => {
    const balances = await balancesByClient(deps.db);
    const clients = new Map((await deps.users.listClients()).map((u) => [u.id, u]));
    const debtors: Array<[bigint, string]> = [];
    const creditors: Array<[bigint, string]> = [];
    let debtTotal = 0n;
    let creditTotal = 0n;
    for (const [id, bal] of balances) {
      const u = clients.get(id);
      if (!u || bal === 0n) continue;
      if (bal < 0n) {
        debtTotal += bal;
        debtors.push([bal, b.debtLine(u, bal)]);
      } else {
        creditTotal += bal;
        creditors.push([bal, b.debtLine(u, bal)]);
      }
    }
    if (!debtors.length && !creditors.length) return void (await ctx.reply(b.noDebts));
    debtors.sort((x, y) => (x[0] < y[0] ? -1 : 1)); // крупнейшие долги первыми
    creditors.sort((x, y) => (x[0] > y[0] ? -1 : 1));
    await ctx.reply(
      b.debtsTitle +
        b.debtsSection(
          'Должны мне',
          debtors.map((x) => x[1]),
          debtTotal,
        ) +
        b.debtsSection(
          'Переплаты / остатки на балансах (я должен клиентам)',
          creditors.map((x) => x[1]),
          creditTotal,
        ),
      html,
    );
  });

  c.command('client', async (ctx) => {
    const id = parseId(ctx.match.trim());
    const user = id === null ? null : await deps.users.getClient(id);
    if (!user) return void (await ctx.reply(t.clientNotFound));
    await ctx.reply(
      b.clientCard(
        user,
        await balanceOf(deps.db, user.id),
        await ledgerHistory(deps.db, user.id, 10),
        deps.config.TIMEZONE,
      ),
      html,
    );
  });

  c.command('adjust', async (ctx) => {
    const m = /^(\d{1,9})\s+([+-]?[\d\s]+(?:[.,]\d{1,2})?)(?:\s+([\s\S]+))?$/.exec(ctx.match.trim());
    if (!m) return void (await ctx.reply(b.adjustUsage));
    const client = await deps.users.getClient(Number(m[1]));
    if (!client) return void (await ctx.reply('Клиент не найден.'));
    const negative = m[2]!.trim().startsWith('-');
    let amount: bigint;
    try {
      amount = parseDecimalToMinor(m[2]!.replace(/^[+-]/, ''));
    } catch (e) {
      if (e instanceof MoneyParseError) return void (await ctx.reply(b.adjustUsage));
      throw e;
    }
    if (amount === 0n || amount > 1_000_000_000n) return void (await ctx.reply(b.adjustUsage));
    const signedAmount = negative ? -amount : amount;
    const comment = m[3]?.trim().slice(0, 200) || null;
    const balance = await deps.topups.adjust(client.id, signedAmount, ctx.appUser!.id, comment);
    await ctx.reply(b.adjustDone(client, signedAmount, balance));
    await deps.notifier.toClient(client.telegramId, b.adjustNotice(signedAmount, balance, comment));
  });

  outer.command(ADMIN_COMMANDS, requireAdmin, c);
  return outer;
}
