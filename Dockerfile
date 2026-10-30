FROM node:25-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
# Корень + webapp — один pnpm-workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY webapp/package.json webapp/
RUN pnpm install --frozen-lockfile
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN pnpm prisma generate
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build
COPY webapp ./webapp
RUN pnpm --filter webapp build

FROM node:25-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/webapp/dist ./webapp/dist
COPY prisma ./prisma
COPY prisma.config.ts ./
USER node
EXPOSE 3000
# Проверка живости: /health (а он проверяет соединение с БД). Docker помечает контейнер unhealthy; бот при этом сам шлёт оповещения.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HTTP_PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node dist/index.js"]
