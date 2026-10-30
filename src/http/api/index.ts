import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { User } from '@prisma/client';
import type { Deps } from '../../bot/context.js';
import { RateLimiter } from '../../services/rate-limiter.js';
import { adminRoutes } from './admin-routes.js';
import { clientRoutes } from './client-routes.js';
import { ApiError, errorHandler } from './errors.js';
import { validateInitData } from './webapp-auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Аутентифицированный пользователь (после проверки initData). */
    actor: User;
  }
}

/**
 * Mini App API. Аутентификация на КАЖДЫЙ запрос: заголовок `Authorization: tma <initData>`,
 * подпись проверяется по токену бота, роль берётся из БД (админ — по ADMIN_TELEGRAM_ID), заблокированные отсекаются.
 */
export async function registerApi(app: FastifyInstance, deps: Deps): Promise<void> {
  const limiter = new RateLimiter(60, 20);

  await app.register(
    async (api) => {
      api.setErrorHandler(errorHandler(deps.log, deps.alerts));
      api.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found', message: 'Не найдено' }));
      api.addHook('onSend', async (_req, reply) => {
        reply.header('Cache-Control', 'no-store');
      });

      api.addHook('preHandler', async (req: FastifyRequest) => {
        const header = req.headers.authorization ?? '';
        const raw = header.startsWith('tma ') ? header.slice(4) : '';
        const res = validateInitData(raw, deps.config.BOT_TOKEN, new Date(), deps.config.WEBAPP_INITDATA_TTL_SEC);
        if (!res.ok) throw new ApiError(401, 'unauthorized', 'Откройте приложение из Telegram заново');

        const tgId = BigInt(res.user.id);
        let user: User | null;
        if (tgId === deps.config.ADMIN_TELEGRAM_ID) {
          user = await deps.users.upsertAdmin({
            id: tgId,
            username: res.user.username,
            displayName: [res.user.first_name, res.user.last_name].filter(Boolean).join(' '),
          });
        } else {
          user = await deps.users.findByTelegramId(tgId);
        }
        if (!user || user.status !== 'ACTIVE') throw new ApiError(403, 'forbidden', 'Доступ закрыт');
        if (!limiter.allow(String(user.id))) throw new ApiError(429, 'rate_limited', 'Слишком часто');
        req.actor = user;
      });

      await api.register(clientRoutes(deps));
      await api.register(adminRoutes(deps), { prefix: '/admin' });
    },
    { prefix: '/api' },
  );
}
