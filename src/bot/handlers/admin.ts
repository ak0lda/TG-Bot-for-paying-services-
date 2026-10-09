import { Composer } from 'grammy';
import type { BotContext, Deps } from '../context.js';
import { requireAdmin } from '../middleware/auth.js';
import { MoneyParseError, parseDecimalToMinor } from '../../domain/money.js';
import { normalizeDomain } from '../../domain/domains.js';
import {
  SettingParseError,
  formatSettingValue,
  isSettingKey,
  parseSettingInput,
} from '../../domain/settings.js';
import { t } from '../../texts/ru.js';

const html = { parse_mode: 'HTML' as const };

export function adminHandlers(deps: Deps): Composer<BotContext> {
  const c = new Composer<BotContext>();
  c.use(requireAdmin);

  // ── Инвайты ────────────────────────────────────────────────
  c.command('invite', async (ctx) => {
    const settings = await deps.settings.getAll();
    const note = ctx.match.trim() || undefined;
    const invite = await deps.invites.create(ctx.appUser!.id, settings.inviteTtlHours, note);
    const link = `https://t.me/${ctx.me.username}?start=${invite.code}`;
    await ctx.reply(t.inviteCreated(link, invite.code, settings.inviteTtlHours), {
      ...html,
      link_preview_options: { is_disabled: true },
    });
  });

  c.command('invites', async (ctx) => {
    const list = await deps.invites.listActive();
    await ctx.reply(
      list.length ? list.map((i) => t.inviteLine(i.code, i.expiresAt, i.note)).join('\n') : t.invitesEmpty,
      html,
    );
  });

  // ── Клиенты ────────────────────────────────────────────────
  c.command('clients', async (ctx) => {
    const list = await deps.users.listClients();
    await ctx.reply(list.length ? list.map(t.clientLine).join('\n') : t.clientsEmpty, html);
  });

  const parseId = (s: string): number | null => (/^\d{1,9}$/.test(s) ? Number(s) : null);

  c.command('block', async (ctx) => {
    const id = parseId(ctx.match.trim());
    if (id === null) return void (await ctx.reply(t.usage('/block <id>')));
    if (!(await deps.users.getClient(id))) return void (await ctx.reply(t.clientNotFound));
    await ctx.reply(t.clientBlocked(await deps.users.setStatus(id, 'BLOCKED')));
  });

  c.command('unblock', async (ctx) => {
    const id = parseId(ctx.match.trim());
    if (id === null) return void (await ctx.reply(t.usage('/unblock <id>')));
    if (!(await deps.users.getClient(id))) return void (await ctx.reply(t.clientNotFound));
    await ctx.reply(t.clientUnblocked(await deps.users.setStatus(id, 'ACTIVE')));
  });

  c.command('paylater', async (ctx) => {
    const [idRaw = '', mode = '', limitRaw] = ctx.match.trim().split(/\s+/);
    const id = parseId(idRaw);
    if (id === null || (mode !== 'on' && mode !== 'off')) {
      return void (await ctx.reply(t.usage('/paylater <id> on [лимит ₽] | off')));
    }
    if (!(await deps.users.getClient(id))) return void (await ctx.reply(t.clientNotFound));
    if (mode === 'off') {
      return void (await ctx.reply(t.payLaterOff(await deps.users.setPayLater(id, false))));
    }
    let limit: bigint;
    try {
      limit = limitRaw
        ? parseDecimalToMinor(limitRaw)
        : BigInt((await deps.settings.getAll()).defaultPayLaterLimitMinor);
    } catch (e) {
      if (e instanceof MoneyParseError) return void (await ctx.reply(t.badAmount));
      throw e;
    }
    await ctx.reply(t.payLaterOn(await deps.users.setPayLater(id, true, limit)));
  });

  // ── Настройки ──────────────────────────────────────────────
  c.command('settings', async (ctx) => {
    const args = ctx.match.trim();
    if (!args) return void (await ctx.reply(t.settingsList(await deps.settings.getAll()), html));
    const [key = '', ...rest] = args.split(/\s+/);
    if (!isSettingKey(key)) return void (await ctx.reply(t.settingUnknown));
    try {
      const value = parseSettingInput(key, rest.join(' '));
      await deps.settings.set(key, value);
      await ctx.reply(t.settingSaved(key, formatSettingValue(key, value)), html);
    } catch (e) {
      if (e instanceof SettingParseError) return void (await ctx.reply(t.settingBad(e.message), html));
      throw e;
    }
  });

  // ── Доверенные домены ──────────────────────────────────────
  c.command('domains', async (ctx) => {
    await ctx.reply(t.domainsList(await deps.domains.list()), html);
  });

  c.command('domain_add', async (ctx) => {
    const domain = normalizeDomain(ctx.match);
    if (!domain) return void (await ctx.reply(t.domainBad));
    await ctx.reply((await deps.domains.add(domain)) ? t.domainAdded(domain) : t.domainExists, html);
  });

  c.command('domain_del', async (ctx) => {
    const domain = normalizeDomain(ctx.match);
    if (!domain) return void (await ctx.reply(t.domainBad));
    await ctx.reply((await deps.domains.remove(domain)) ? t.domainRemoved(domain) : t.domainMissing, html);
  });

  return c;
}
