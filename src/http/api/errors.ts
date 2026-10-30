import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import type { Logger } from '../../logger.js';
import type { AlertService } from '../../services/alerts.js';
import { InvalidTransitionError } from '../../domain/order-fsm.js';
import {
  ForbiddenError, OrderDataError, OrderNotFoundError, PayLaterDeniedError, PayLaterLimitError, RenewalExistsError, RequisitesNotAllowedError, RequisitesNotSentError, StaleOrderError,
} from '../../services/order-service.js';
import { RateUnavailableError } from '../../services/rates.js';
import { safeError } from '../../logging/safe-error.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message ?? code);
  }
}

/** Доменные ошибки -> HTTP-ответы. Неизвестные ошибки не раскрываются клиенту. */
export function toApiError(e: unknown): ApiError | null {
  if (e instanceof ApiError) return e;
  if (e instanceof ZodError) {
    return new ApiError(400, 'validation', 'Некорректные данные', {
      issues: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  if (e instanceof StaleOrderError) return new ApiError(409, 'stale', 'Заявка уже изменилась', { currentVersion: e.order.version });
  if (e instanceof InvalidTransitionError) return new ApiError(409, 'invalid_transition', 'Действие сейчас недоступно');
  if (e instanceof ForbiddenError) return new ApiError(403, 'forbidden', 'Нет доступа');
  if (e instanceof OrderNotFoundError) return new ApiError(404, 'not_found', 'Заявка не найдена');
  if (e instanceof RateUnavailableError) return new ApiError(422, 'rate_unavailable', `Нет курса для ${e.currency}`, { currency: e.currency });
  if (e instanceof OrderDataError) return new ApiError(422, 'bad_order', 'Заявка в неподходящем состоянии');
  if (e instanceof RequisitesNotSentError) return new ApiError(409, 'requisites_not_sent', 'Админ ещё не прислал реквизиты');
  if (e instanceof RequisitesNotAllowedError) return new ApiError(409, 'requisites_not_allowed', 'Реквизиты можно отправить только пока заявка ждёт оплату');
  if (e instanceof PayLaterDeniedError) return new ApiError(409, 'pay_later_denied', 'Оплата позже не включена');
  if (e instanceof PayLaterLimitError) {
    return new ApiError(409, 'pay_later_limit', 'Превышен лимит оплаты позже', {
      limitMinor: e.limitMinor.toString(),
      exposureMinor: e.exposureMinor.toString(),
    });
  }
  if (e instanceof RenewalExistsError) return new ApiError(409, 'renewal_exists', 'Продление уже оформлено', { orderId: e.order.id });
  return null;
}

export function errorHandler(log: Logger, alerts?: AlertService) {
  return (error: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) => {
    const api = toApiError(error);
    if (api) return reply.code(api.status).send({ error: api.code, message: api.message, ...api.extra });
    if ('statusCode' in error && typeof error.statusCode === 'number' && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: 'bad_request', message: 'Некорректный запрос' });
    }
    // Без тела запроса и заголовков: только технические данные.
    log.error({ ...safeError(error), method: req.method, route: req.routeOptions?.url }, 'api request failed');
    void alerts?.error(`api:${req.routeOptions?.url}:${safeError(error).err}`, 'Ошибка Mini App API', error, `маршрут: ${req.method} ${req.routeOptions?.url ?? '?'}`);
    return reply.code(500).send({ error: 'internal', message: 'Внутренняя ошибка' });
  };
}
