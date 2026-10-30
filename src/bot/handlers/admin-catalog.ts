import { Composer } from 'grammy';
import type { BotContext, Deps } from '../context.js';
import { requireAdmin } from '../middleware/auth.js';
import { MoneyParseError, parseDecimalToMinor } from '../../domain/money.js';
import { detectSecret } from '../../domain/secret-detector.js';
import { RateUnavailableError } from '../../services/rates.js';
import { c as ct } from '../../texts/catalog.js';
import { o as ot } from '../../texts/orders.js';
import { escapeHtml } from '../../texts/ru.js';

const html = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };
const parseId = (s: string): number | null => (/^\d{1,9}$/.test(s.trim()) ? Number(s.trim()) : null);
const yesNo = (s: string): boolean | null => {
  const v = s.trim().toLowerCase();
  if (['да', 'yes', 'y', '+', '1'].includes(v)) return true;
  if (['нет', 'no', 'n', '-', '0'].includes(v)) return false;
  return null;
};

const ADMIN_COMMANDS = [
  'orders',
  'cards',
  'card_add',
  'card_toggle',
  'methods',
  'method_add',
  'method_edit',
  'method_receipt',
  'method_toggle',
  'method_limits',
  'method_auto',
  'rate',
];

export function adminCatalogHandlers(deps: Deps): Composer<BotContext> {
  const outer = new Composer<BotContext>();
  const c = new Composer<BotContext>();

  // ── Очередь заявок ─────────────────────────────────────────
  c.command('orders', async (ctx) => {
    const orders = await deps.orders.listOpen();
    if (orders.length === 0) return void (await ctx.reply(ot.noOpenOrders));
    await ctx.reply(ot.openOrdersTitle, { reply_markup: deps.presenter.list(orders, true) });
  });

  // ── Карты (только метка + валюта) ──────────────────────────
  c.command('cards', async (ctx) => {
    const cards = await deps.catalog.listCards();
    await ctx.reply((cards.length ? cards.map(ct.cardLine).join('\n') : ct.cardsEmpty) + ct.cardsHint, html);
  });

  c.command('card_add', async (ctx) => {
    const parts = ctx.match.trim().split(/\s+/);
    const currency = (parts.pop() ?? '').toUpperCase();
    const label = parts.join(' ').trim();
    if (!label || !currency) return void (await ctx.reply(ct.cardUsage));
    const bad =
      !/^[A-Z]{3}$/.test(currency) ||
      label.length < 2 ||
      label.length > 30 ||
      /\d{5,}/.test(label) ||
      detectSecret(label) !== null;
    if (bad) return void (await ctx.reply(ct.cardBad));
    await ctx.reply(ct.cardAdded(await deps.catalog.addCard(label, currency)), html);
  });

  c.command('card_toggle', async (ctx) => {
    const id = parseId(ctx.match);
    const card = id === null ? null : await deps.catalog.getCard(id);
    if (!card) return void (await ctx.reply(ct.cardNotFound));
    await ctx.reply(ct.cardToggled(await deps.catalog.setCardActive(card.id, !card.isActive)));
  });

  // ── Способы оплаты от клиентов ─────────────────────────────
  c.command('methods', async (ctx) => {
    const list = await deps.catalog.listMethods();
    await ctx.reply((list.length ? list.map(ct.methodLine).join('\n\n') : ct.methodsEmpty) + ct.methodsHint, html);
  });

  c.command('method_add', async (ctx) => {
    const [title = '', rawText = '', receiptRaw = 'да'] = ctx.match.split('|').map((s) => s.trim());
    if (!title) return void (await ctx.reply(ct.methodUsage));
    const instructions = rawText === '-' ? '' : rawText;
    if (
      title.length < 2 ||
      title.length > 40 ||
      instructions.length > 1000 ||
      (instructions && instructions.length < 2)
    ) {
      return void (await ctx.reply(ct.methodBad));
    }
    if (detectSecret(instructions) === 'card_number') return void (await ctx.reply(ct.methodHasCard));
    const receipt = yesNo(receiptRaw);
    if (receipt === null) return void (await ctx.reply(ct.methodUsage));
    await ctx.reply(ct.methodAdded(await deps.catalog.addMethod(title, instructions, receipt)), html);
  });

  c.command('method_edit', async (ctx) => {
    const sep = ctx.match.indexOf('|');
    const id = sep > 0 ? parseId(ctx.match.slice(0, sep)) : null;
    const rawText = sep > 0 ? ctx.match.slice(sep + 1).trim() : '';
    const text = rawText === '-' ? '' : rawText;
    if (id === null || !rawText) return void (await ctx.reply(ct.methodUsage));
    if (text.length > 1000 || (text && text.length < 2)) return void (await ctx.reply(ct.methodBad));
    if (detectSecret(text) === 'card_number') return void (await ctx.reply(ct.methodHasCard));
    if (!(await deps.catalog.getMethod(id))) return void (await ctx.reply(ct.methodNotFound));
    await ctx.reply(ct.methodUpdated(await deps.catalog.updateMethod(id, { instructions: text })), html);
  });

  c.command('method_receipt', async (ctx) => {
    const [idRaw = '', flagRaw = ''] = ctx.match.trim().split(/\s+/);
    const id = parseId(idRaw);
    const flag = yesNo(flagRaw);
    if (id === null || flag === null) return void (await ctx.reply('Использование: /method_receipt <id> да|нет'));
    if (!(await deps.catalog.getMethod(id))) return void (await ctx.reply(ct.methodNotFound));
    await ctx.reply(ct.methodUpdated(await deps.catalog.updateMethod(id, { requiresReceipt: flag })), html);
  });

  c.command('method_toggle', async (ctx) => {
    const id = parseId(ctx.match);
    const m = id === null ? null : await deps.catalog.getMethod(id);
    if (!m) return void (await ctx.reply(ct.methodNotFound));
    await ctx.reply(ct.methodUpdated(await deps.catalog.updateMethod(m.id, { isActive: !m.isActive })), html);
  });

  c.command('method_limits', async (ctx) => {
    const [idRaw = '', minRaw, maxRaw] = ctx.match.trim().split(/\s+/);
    const id = parseId(idRaw);
    if (id === null || minRaw === undefined) return void (await ctx.reply(ct.limitsUsage));
    if (!(await deps.catalog.getMethod(id))) return void (await ctx.reply(ct.methodNotFound));
    let min: bigint | null = null;
    let max: bigint | null = null;
    if (minRaw.toLowerCase() !== 'off') {
      if (maxRaw === undefined) return void (await ctx.reply(ct.limitsUsage));
      try {
        min = minRaw === '-' ? null : parseDecimalToMinor(minRaw);
        max = maxRaw === '-' ? null : parseDecimalToMinor(maxRaw);
      } catch (e) {
        if (e instanceof MoneyParseError) return void (await ctx.reply(ct.limitsBad));
        throw e;
      }
      if (min !== null && max !== null && min > max) return void (await ctx.reply(ct.limitsBad));
    }
    await ctx.reply(ct.limitsSet(await deps.catalog.updateMethod(id, { minAmountMinor: min, maxAmountMinor: max })));
  });

  c.command('method_auto', async (ctx) => {
    const [idRaw = '', flagRaw = ''] = ctx.match.trim().split(/\s+/);
    const id = parseId(idRaw);
    const flag = flagRaw === 'on' ? true : flagRaw === 'off' ? false : null;
    if (id === null || flag === null) return void (await ctx.reply(ct.autoUsage));
    const m = await deps.catalog.getMethod(id);
    if (!m) return void (await ctx.reply(ct.methodNotFound));
    if (flag && !m.instructions.trim()) return void (await ctx.reply(ct.autoNeedsText));
    await ctx.reply(ct.autoSet(await deps.catalog.updateMethod(id, { autoSend: flag })));
  });

  // ── Курсы ──────────────────────────────────────────────────
  c.command('rate', async (ctx) => {
    const [curRaw, valueRaw] = ctx.match.trim().split(/\s+/);
    if (!curRaw) {
      const manual = (await deps.rates.listManual()).map((m) => m.currency);
      const cur = [...new Set(['USD', 'EUR', 'GBP', ...manual])];
      const lines: string[] = [ct.rateHeader];
      for (const code of cur) {
        try {
          const r = await deps.rates.getRate(code);
          const time = new Intl.DateTimeFormat('ru-RU', {
            timeZone: deps.config.TIMEZONE,
            day: '2-digit',
            month: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          }).format(r.at);
          lines.push(ct.rateLine(code, r.scaled, r.source === 'MANUAL' ? 'ручной' : 'ЦБ', time));
        } catch (e) {
          if (!(e instanceof RateUnavailableError)) throw e;
          lines.push(ct.rateNone(code));
        }
      }
      return void (await ctx.reply(lines.join('\n') + '\n\n' + escapeHtml(ct.rateUsage), html));
    }
    const code = curRaw.toUpperCase();
    if (!/^[A-Z]{3}$/.test(code) || code === 'RUB') return void (await ctx.reply(ct.rateUsage));
    if (!valueRaw) return void (await ctx.reply(ct.rateUsage));
    if (valueRaw.toLowerCase() === 'clear') {
      await deps.rates.clearManual(code);
      return void (await ctx.reply(ct.rateCleared(code)));
    }
    try {
      await ctx.reply(ct.rateSet(code, await deps.rates.setManual(code, valueRaw)));
    } catch (e) {
      if (e instanceof RangeError) return void (await ctx.reply(ct.rateBad));
      throw e;
    }
  });

  outer.command(ADMIN_COMMANDS, requireAdmin, c);
  return outer;
}
