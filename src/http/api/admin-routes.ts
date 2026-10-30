import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../bot/context.js';
import { notifyOrderDone } from '../../bot/notify-done.js';
import { deliverOrderRequisites } from '../../bot/requisites.js';
import { isTrustedDomain } from '../../domain/link-validator.js';
import { MoneyParseError, parseDecimalToMinor } from '../../domain/money.js';
import { RATE_SCALE, formatRate, parseRate } from '../../domain/pricing.js';
import { parseRange } from '../../domain/range.js';
import type { OrderWithClient } from '../../services/order-service.js';
import { o as ot } from '../../texts/orders.js';
import { warningText } from '../../texts/rates.js';
import { ApiError } from './errors.js';
import { orderDto } from './dto.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const versioned = z.object({ version: z.number().int().positive() });

export function adminRoutes(deps: Deps) {
  return async (app: FastifyInstance): Promise<void> => {
    // Проверка роли на каждый админский маршрут.
    app.addHook('preHandler', async (req) => {
      if (req.actor.role !== 'ADMIN') throw new ApiError(403, 'forbidden', 'Только для администратора');
    });

    const dto = async (o: OrderWithClient) => {
      const trusted = o.urlDomain ? isTrustedDomain(o.urlDomain, await deps.domains.list()) : null;
      return orderDto(o, 'ADMIN', {
        trusted,
        client: o.client,
        method: o.payMethodId ? await deps.catalog.getMethod(o.payMethodId) : null,
      });
    };
    const load = async (req: { params: unknown }) => deps.orders.getOrThrow(idParam.parse(req.params).id);

    app.get('/orders', async () => {
      const orders = await deps.orders.listOpen();
      return { orders: await Promise.all(orders.map(dto)) };
    });

    app.get('/orders/:id', async (req) => ({ order: await dto(await load(req)) }));

    app.post('/orders/:id/quote', async (req) => {
      const body = versioned.extend({ force: z.boolean().optional() }).parse(req.body);
      const current = await load(req);
      // До расчёта проверяем курс. Есть предупреждения — отвечаем 409 rate_warning; с force: true админ подтверждает осознанно.
      if (current.currency) {
        const { warnings } = await deps.rates.assess(current.currency);
        if (warnings.length > 0 && !body.force) {
          throw new ApiError(409, 'rate_warning', 'Проверьте курс перед расчётом', {
            currency: current.currency,
            warnings: warnings.map((w) => ({ kind: w.kind, text: warningText(w, current.currency!) })),
          });
        }
        if (warnings.length > 0) await deps.rates.acknowledge(current.currency);
      }
      const order = await deps.orders.quote(current.id, body.version, { role: 'ADMIN', userId: req.actor.id });
      await deps.presenter.notifyClient(order, ot.quoteReady(order.id));
      return { order: await dto(order) };
    });

    app.post('/orders/:id/confirm-payment', async (req) => {
      const { version } = versioned.parse(req.body);
      const order = await deps.orders.confirmPayment((await load(req)).id, version, req.actor.id);
      await deps.notifier.toClient(order.client.telegramId, ot.paymentConfirmed(order.id));
      return { order: await dto(order) };
    });

    app.post('/orders/:id/payment-not-found', async (req) => {
      const { version } = versioned.parse(req.body);
      const order = await deps.orders.paymentNotFound((await load(req)).id, version, req.actor.id);
      await deps.presenter.notifyClient(order, ot.paymentNotFound(order.id));
      return { order: await dto(order) };
    });

    app.post('/orders/:id/link-invalid', async (req) => {
      const { version } = versioned.parse(req.body);
      const order = await deps.orders.markLinkInvalid((await load(req)).id, version, req.actor.id);
      await deps.presenter.notifyClient(order, ot.linkInvalidNotice(order.id));
      return { order: await dto(order) };
    });

    /** Админ выбирает способ перевода и присылает реквизиты клиенту (текст не сохраняется). */
    app.post('/orders/:id/requisites', async (req) => {
      const body = versioned
        .extend({ methodId: z.number().int().positive(), text: z.string().trim().min(3).max(1000).optional() })
        .parse(req.body);
      const order = await load(req);
      const method = await deps.catalog.getMethod(body.methodId);
      if (!method || !method.isActive) throw new ApiError(422, 'method_not_found', 'Способ не найден', { field: 'methodId' });
      const text = body.text ?? (method.instructions || undefined);
      if (!text) throw new ApiError(422, 'text_required', ot.requisitesBadText, { field: 'text' });
      const updated = await deps.orders.setPayMethod(order.id, body.version, req.actor.id, method.id, method.title);
      await deliverOrderRequisites(deps, updated, method, text);
      return { order: await dto(updated) };
    });

    app.post('/orders/:id/reject', async (req) => {
      const body = versioned.extend({ reason: z.string().trim().min(2).max(300) }).parse(req.body);
      const order = await deps.orders.reject((await load(req)).id, body.version, req.actor.id, body.reason);
      const kept = order.paidAt ? `\n${ot.balanceKept}` : '';
      await deps.notifier.toClient(order.client.telegramId, ot.rejectedNotice(order.id, body.reason) + kept);
      return { order: await dto(order) };
    });

    /** Выполнено: карта, фактическое списание, курс (по умолчанию ЦБ/ручной), код для подарочных карт. */
    app.post('/orders/:id/complete', async (req) => {
      const body = versioned
        .extend({
          cardId: z.number().int().positive(),
          actual: z.string().trim().min(1).max(20),
          rate: z.string().trim().max(20).optional(),
          giftCode: z.string().trim().min(3).max(500).optional(),
        })
        .parse(req.body);
      const order = await load(req);
      const card = await deps.catalog.getCard(body.cardId);
      if (!card || !card.isActive) throw new ApiError(422, 'card_not_found', 'Карта не найдена', { field: 'cardId' });
      if (order.type === 'GIFT_CARD' && !body.giftCode) throw new ApiError(422, 'gift_code_required', ot.giftCodePrompt, { field: 'giftCode' });

      let actualMinor: bigint;
      try {
        actualMinor = parseDecimalToMinor(body.actual);
      } catch (e) {
        if (e instanceof MoneyParseError) throw new ApiError(422, 'bad_amount', ot.badAmount, { field: 'actual' });
        throw e;
      }
      if (actualMinor <= 0n || actualMinor > 10_000_000_000n) throw new ApiError(422, 'amount_limit', ot.amountLimit, { field: 'actual' });

      let rateScaled: bigint;
      if (card.currency === 'RUB') rateScaled = RATE_SCALE;
      else if (body.rate) {
        try {
          rateScaled = parseRate(body.rate);
        } catch {
          throw new ApiError(422, 'bad_rate', ot.badRate, { field: 'rate' });
        }
      } else rateScaled = (await deps.rates.getRate(card.currency)).scaled;

      const { order: done, settlement } = await deps.orders.complete(order.id, body.version, req.actor.id, {
        cardId: card.id,
        actualChargeMinor: actualMinor,
        cardRateScaled: rateScaled,
        ...(body.giftCode ? { giftCode: body.giftCode } : {}),
      });
      deps.log.info({ orderId: done.id, via: 'webapp' }, 'order done');
      await notifyOrderDone(deps, done, settlement, body.giftCode);
      return {
        order: await dto(done),
        settlement: {
          actualRubMinor: settlement.actualRubMinor.toString(),
          baseCostMinor: settlement.baseCostMinor.toString(),
          diffMinor: settlement.diffMinor.toString(),
        },
      };
    });

    app.get('/rate/:currency', async (req) => {
      const cur = z.string().length(3).transform((s) => s.toUpperCase()).parse((req.params as { currency: string }).currency);
      const rate = await deps.rates.getRate(cur);
      return { currency: cur, rate: formatRate(rate.scaled), scaled: rate.scaled.toString(), source: rate.source };
    });

    app.get('/stats', async (req) => {
      const q = z.object({ period: z.string().max(30).default('month') }).parse(req.query);
      const range = parseRange(q.period, new Date(), deps.config.TIMEZONE);
      if (!range) throw new ApiError(400, 'bad_period', 'Неизвестный период');
      const rep = await deps.reports.stats(range);
      const s = rep.stats;
      const rows = (list: typeof s.byClient) =>
        list.slice(0, 10).map((x) => ({ label: x.label, count: x.count, turnoverMinor: x.turnoverMinor.toString() }));
      return {
        label: range.label,
        created: rep.createdByStatus,
        count: s.count,
        turnoverMinor: s.turnoverMinor.toString(),
        costMinor: s.costMinor.toString(),
        profitMinor: s.profitMinor.toString(),
        topUpMinor: rep.topUpMinor.toString(),
        repaidMinor: rep.repaidMinor.toString(),
        byClient: rows(s.byClient),
        byService: rows(s.byService),
        byCard: s.byCard.map((c) => ({
          label: c.label, currency: c.currency, count: c.count,
          chargeMinor: c.chargeMinor.toString(), rubMinor: c.rubMinor.toString(),
        })),
      };
    });

  };
}
