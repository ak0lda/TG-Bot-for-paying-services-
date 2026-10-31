import { Composer } from 'grammy';
import type { BotContext, Deps } from '../context.js';
import { requireAdmin } from '../middleware/auth.js';
import { MoneyParseError, parseDecimalToMinor } from '../../domain/money.js';
import { normalizeDomain } from '../../domain/domains.js';
import { SettingParseError, formatSettingValue, isSettingKey, parseSettingInput } from '../../domain/settings.js';
import { balancesByClient } from '../../services/ledger-service.js';
import { escapeHtml, t } from '../../texts/ru.js';

const html = { parse_mode: 'HTML' as const };

const ADMIN_COMMANDS = [
  'invite',
  'invites',
  'clients',
  'block',
  'unblock',
  'paylater',
  'settings',
  'domains',
  'domain_add',
  'domain_del',
  'domain_ban',
  'domain_unban',
  'banned',
];

export function adminHandlers(deps: Deps): Composer<BotContext> {
  const outer = new Composer<BotContext>();
  const c = new Composer<BotContext>();

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
    const balances = await balancesByClient(deps.db);
    await ctx.reply(
      list.length ? list.map((u) => t.clientLine(u, balances.get(u.id) ?? 0n)).join('\n') : t.clientsEmpty,
      html,
    );
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

  // Проверка роли только на админские команды: остальные апдейты проходят мимо к клиентским обработчикам.
  // ── Чёрный список доменов ──────────────────────────────────
  c.command('domain_ban', async (ctx) => {
    const [domainRaw = '', ...reason] = ctx.match.trim().split(/\s+/);
    const domain = normalizeDomain(domainRaw);
    if (!domain) return void (await ctx.reply(t.usage('/domain_ban <домен> [причина]')));
    if (!(await deps.linkSafety.ban(domain, reason.join(' ').slice(0, 200) || undefined))) {
      return void (await ctx.reply(t.banExists));
    }
    const open = await deps.db.order.count({
      where: { urlDomain: { in: [domain] }, status: { notIn: ['DONE', 'CANCELED', 'REJECTED'] } },
    });
    await ctx.reply(t.banned(domain, open), html);
  });

  c.command('domain_unban', async (ctx) => {
    const domain = normalizeDomain(ctx.match);
    if (!domain) return void (await ctx.reply(t.usage('/domain_unban <домен>')));
    await ctx.reply((await deps.linkSafety.unban(domain)) ? t.unbanned(domain) : t.domainMissing, html);
  });

  c.command('banned', async (ctx) => {
    const list = await deps.linkSafety.listBanned();
    await ctx.reply(
      list.length
        ? t.bannedList(list.map((b) => `${escapeHtml(b.domain)}${b.reason ? ` — ${escapeHtml(b.reason)}` : ''}`))
        : t.bannedEmpty,
      html,
    );
  });

  outer.command(ADMIN_COMMANDS, requireAdmin, c);
  return outer;
}
