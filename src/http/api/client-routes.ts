import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../bot/context.js';
import { autoSendOrderRequisites } from '../../bot/auto-requisites.js';
import { availableModes } from '../../bot/wizard/pay-modes.js';
import { formatRub } from '../../domain/money.js';
import { debtOf, availableOf } from '../../domain/ledger.js';
import { validateLink } from '../../domain/link-validator.js';
import { balanceOf, ledgerHistory } from '../../services/ledger-service.js';
import { CLIENT, type OrderWithClient } from '../../services/order-service.js';
import { o as ot } from '../../texts/orders.js';
import { warningText } from '../../texts/rates.js';
import { r } from '../../texts/reports.js';
import { ApiError } from './errors.js';
import { ledgerDto, orderDto } from './dto.js';
import { toNewOrderInput } from './order-input.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const versioned = z.object({ version: z.number().int().positive() });

export function clientRoutes(deps: Deps) {
  return async (app: FastifyInstance): Promise<void> => {
    const ownOrder = async (req: { actor: { id: number }; params: unknown }): Promise<OrderWithClient> => {
      const { id } = idParam.parse(req.params);
      const order = await deps.orders.get(id);
      // Чужая заявка выглядит как несуществующая — не раскрываем факт её наличия.
      if (!order || order.clientId !== req.actor.id) throw new ApiError(404, 'not_found', 'Заявка не найдена');
      return order;
    };
    const dtoFor = async (o: OrderWithClient) =>
      orderDto(o, 'CLIENT', { method: o.payMethodId ? await deps.catalog.getMethod(o.payMethodId) : null });

    // ── Профиль и справочники ────────────────────────────────
    app.get('/me', async (req) => {
      const u = req.actor;
      const balance = await balanceOf(deps.db, u.id);
      const base = {
        id: u.id,
        role: u.role,
        name: u.displayName,
        balanceMinor: balance.toString(),
        debtMinor: debtOf(balance).toString(),
        availableMinor: availableOf(balance).toString(),
        webAppUrl: deps.config.WEBAPP_URL ?? null,
      };
      if (u.role === 'ADMIN') {
        const cards = await deps.catalog.listCards(true);
        const settings = await deps.settings.getAll();
        return {
          ...base,
          staleLinkHours: settings.staleLinkHours,
          cards: cards.map((c) => ({ id: c.id, label: c.label, currency: c.currency })),
          methods: (await deps.catalog.listMethods(true)).map((m) => ({ id: m.id, title: m.title, hasSavedText: m.instructions.length > 0 })),
        };
      }
      return {
        ...base,
        payModes: (await availableModes(deps, u.id)).map((m) => ({ mode: m.mode, label: m.label })),
      };
    });

    // ── Заявки клиента ───────────────────────────────────────
    app.get('/orders', async (req) => {
      const orders = await deps.orders.listForClient(req.actor.id, 30);
      return { orders: orders.map((o) => orderDto(o, 'CLIENT')) };
    });

    app.get('/orders/:id', async (req) => ({ order: await dtoFor(await ownOrder(req)) }));

    app.post('/orders', async (req, reply) => {
      if (req.actor.role !== 'CLIENT') throw new ApiError(403, 'forbidden', 'Только для клиентов');
      const { input, untrusted } = await toNewOrderInput(deps, req.actor.id, req.body);
      const order = await deps.orders.create(input);
      deps.log.info({ orderId: order.id, type: order.type, via: 'webapp' }, 'order created');
      await deps.presenter.notifyAdmin(order, ot.adminNewOrder);
      return reply.code(201).send({ order: await dtoFor(order), untrustedDomain: untrusted });
    });

    app.post('/orders/:id/confirm', async (req) => {
      const { version } = versioned.parse(req.body);
      const order = await ownOrder(req);
      // Способ перевода клиент не выбирает: админ выберет его и пришлёт реквизиты.
      const res = await deps.orders.confirmQuote(order.id, version, req.actor.id, null);
      if (!res.expired) {
        if (res.order.status === 'IN_PROGRESS') {
          await deps.presenter.notifyAdmin(res.order, ot.adminInProgress(res.order.id, ot.payModeShort[res.order.payMode]));
        } else {
          const due = formatRub(res.order.payDueMinor ?? res.order.totalMinor ?? 0n);
          const auto = await autoSendOrderRequisites(deps, res.order);
          if (auto.sent) {
            res.order = auto.order;
            await deps.presenter.notifyAdmin(auto.order, ot.adminAutoRequisites(auto.order.id, auto.method.title, due));
          } else {
            await deps.presenter.notifyAdmin(res.order, auto.hadCandidates ? ot.adminAutoMiss(res.order.id, due) : ot.adminNeedRequisites(res.order.id));
          }
        }
      }
      return { expired: res.expired, order: await dtoFor(res.order) };
    });

    app.post('/orders/:id/paid', async (req) => {
      const { version } = versioned.parse(req.body);
      const order = await ownOrder(req);
      const method = order.payMethodId ? await deps.catalog.getMethod(order.payMethodId) : null;
      // Скриншот чека в Telegram-боте хранится как file_id; из Mini App его получить нельзя — чек отправляется в чате.
      if (!method) throw new ApiError(409, 'requisites_not_sent', ot.noRequisitesYet);
      if (method.requiresReceipt) {
        throw new ApiError(409, 'receipt_required', 'Для этого способа нужен чек — отправь его в чате с ботом (кнопка «Я оплатил»).');
      }
      const updated = await deps.orders.markPaid(order.id, version, req.actor.id);
      await deps.presenter.notifyAdmin(updated, ot.adminPaid(updated.id));
      return { order: await dtoFor(updated) };
    });

    app.post('/orders/:id/cancel', async (req) => {
      const { version } = versioned.parse(req.body);
      const order = await ownOrder(req);
      const updated = await deps.orders.cancel(order.id, version, req.actor.id);
      await deps.notifier.toAdmin(ot.adminCanceled(order.id, order.status === 'PAYMENT_CHECK'));
      return { order: await dtoFor(updated) };
    });

    app.post('/orders/:id/requote', async (req) => {
      const { version } = versioned.parse(req.body);
      const order = await ownOrder(req);
      const warnings = order.currency ? (await deps.rates.assess(order.currency)).warnings : [];
      const updated = await deps.orders.requote(order.id, version, CLIENT(req.actor.id));
      const note = warnings.length ? `\n${warnings.map((w) => warningText(w, order.currency!)).join('\n')}` : '';
      await deps.presenter.notifyAdmin(updated, ot.adminRequoted(updated.id) + note);
      return { order: await dtoFor(updated) };
    });

    app.post('/orders/:id/new-link', async (req) => {
      const body = versioned.extend({ url: z.string().trim().min(1).max(2048) }).parse(req.body);
      const order = await ownOrder(req);
      const link = validateLink(body.url, await deps.domains.list());
      if (!link.ok) throw new ApiError(422, `link_${link.error}`, ot.link[link.error], { field: 'url' });
      const updated = await deps.orders.submitNewLink(order.id, body.version, req.actor.id, link.url, link.domain);
      await deps.presenter.notifyAdmin(updated, ot.adminNewLink(updated.id));
      return { order: await dtoFor(updated), untrustedDomain: !link.trusted };
    });

    app.post('/orders/:id/renew', async (req, reply) => {
      const body = z.object({ url: z.string().trim().max(2048).optional(), payMode: z.enum(['PREPAY', 'BALANCE', 'PAY_LATER']).default('PREPAY') }).parse(req.body);
      const src = await ownOrder(req);
      const needsUrl = src.type !== 'GIFT_CARD' && (src.type !== 'OTHER' || !!src.url);
      let url: string | null = null;
      let urlDomain: string | null = null;
      if (needsUrl) {
        if (!body.url) throw new ApiError(422, 'url_required', 'Нужна свежая ссылка на оплату', { field: 'url' });
        const link = validateLink(body.url, await deps.domains.list());
        if (!link.ok) throw new ApiError(422, `link_${link.error}`, ot.link[link.error], { field: 'url' });
        url = link.url;
        urlDomain = link.domain;
      }
      if (!(await availableModes(deps, req.actor.id)).some((m) => m.mode === body.payMode)) {
        throw new ApiError(422, 'pay_mode_unavailable', ot.payModeUnavailable, { field: 'payMode' });
      }
      const order = await deps.orders.renew(src.id, req.actor.id, { url, urlDomain, payMode: body.payMode });
      await deps.presenter.notifyAdmin(order, r.adminRenewal(src.id));
      return reply.code(201).send({ order: await dtoFor(order) });
    });

    // ── Баланс ───────────────────────────────────────────────
    app.get('/balance', async (req) => {
      const balance = await balanceOf(deps.db, req.actor.id);
      return {
        balanceMinor: balance.toString(),
        debtMinor: debtOf(balance).toString(),
        pendingTopUps: await deps.topups.pendingCount(req.actor.id),
        entries: (await ledgerHistory(deps.db, req.actor.id, 30)).map(ledgerDto),
        topUpHint: 'Пополнение с чеком — в чате с ботом: «➕ Пополнить баланс».',
      };
    });
  };
}
