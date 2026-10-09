# Закрытый Telegram-бот для учёта оплаты зарубежных сервисов

Бот автоматизирует учёт: заявки друзей, расчёт суммы в рублях, приём оплаты, статусы, балансы, история, напоминания.
Саму оплату картой админ делает вручную. **Бот не хранит и не обрабатывает реквизиты банковских карт** — только метки вида «Visa ··4417».

> Статус: **этап 1 из 5** (каркас, БД, доступ по инвайтам, настройки). См. `docs/CONTEXT_SNAPSHOT.md`.

## Стек
Node.js 20+, TypeScript (strict), pnpm, grammY, PostgreSQL + Prisma, Fastify, Zod, pino, Vitest, Docker.

## Быстрый старт (локально, long polling)
```bash
pnpm install
cp .env.example .env            # заполни BOT_TOKEN, ADMIN_TELEGRAM_ID, ENCRYPTION_KEY, POSTGRES_PASSWORD
openssl rand -base64 32         # → ENCRYPTION_KEY
docker compose up -d db         # только база
pnpm prisma migrate deploy
pnpm dev
```
Без Docker подойдёт любой PostgreSQL 14+: поправь `DATABASE_URL`.

## Запуск на сервере (VPS)
```bash
git clone <repo> && cd <repo>
cp .env.example .env            # заполнить; BOT_MODE=polling не требует домена и HTTPS
docker compose up -d --build    # db + app + backup
docker compose logs -f app
```
Миграции применяются автоматически при старте контейнера `app`. Бэкапы: `./backups` (ежедневно, хранится 14 дней).
Восстановление: `gunzip -c backups/daily/<файл>.sql.gz | docker compose exec -T db psql -U bot bot`.

**Webhook (по желанию):** нужен домен с A-записью на сервер. В `.env`: `BOT_MODE=webhook`,
`WEBHOOK_URL=https://<домен>/webhook`, `WEBHOOK_SECRET=<16+ символов>`, `DOMAIN=<домен>`; запуск:
`docker compose --profile webhook up -d --build` (Caddy сам получит сертификат).

## Переменные окружения
| Переменная | Описание |
|---|---|
| `BOT_TOKEN` | токен от @BotFather |
| `ADMIN_TELEGRAM_ID` | твой Telegram ID — единственный админ |
| `ADMIN_CHAT_ID` | куда слать служебные уведомления (по умолчанию = админ) |
| `BOT_MODE` | `polling` (по умолчанию) или `webhook` |
| `WEBHOOK_URL`, `WEBHOOK_SECRET` | только для webhook; секрет проверяется по `X-Telegram-Bot-Api-Secret-Token` |
| `HTTP_HOST`, `HTTP_PORT` | Fastify (`/health`, `/webhook`) |
| `DATABASE_URL` | строка подключения PostgreSQL |
| `POSTGRES_USER/PASSWORD/DB` | для docker-compose |
| `ENCRYPTION_KEY` | 32 байта base64, AES-256-GCM для кодов подарочных карт. **Сохрани копию отдельно от бэкапов БД** |
| `TIMEZONE` | часовой пояс напоминаний (`Europe/Moscow`) |
| `LOG_LEVEL` | `info` по умолчанию |

## Как создать первого клиента
1. Напиши боту `/start` со своего аккаунта (ID из `ADMIN_TELEGRAM_ID`) — получишь меню админа.
2. `/invite Вася` — бот пришлёт одноразовую ссылку `https://t.me/<bot>?start=<код>` (действует 72 ч).
3. Друг открывает ссылку и жмёт Start — регистрируется, тебе приходит уведомление.
4. Все остальные получают вежливый отказ.

## Команды (этап 1)
| Команда | Что делает |
|---|---|
| `/invite [заметка]`, `/invites` | создать инвайт / список активных |
| `/clients` | клиенты с id, статусом и лимитом «оплаты позже» |
| `/block <id>`, `/unblock <id>` | заблокировать / разблокировать клиента |
| `/paylater <id> on [лимит ₽]`, `/paylater <id> off` | «оплата позже» и лимит долга |
| `/settings`, `/settings <ключ> <значение>` | запас на конвертацию, наценка, фикс. комиссия, TTL расчёта и др. |
| `/domains`, `/domain_add <домен>`, `/domain_del <домен>` | доверенные платёжные домены |

Методы оплаты (`/methods`) и карты (`/cards`) появятся на этапах 2–3; справочники и их таблицы уже есть в БД
(по умолчанию заведены «СБП», «Перевод на карту», «Наличные»).

## Разработка
```bash
pnpm test         # юнит-тесты
TEST_DATABASE_URL=postgresql://... pnpm test   # + интеграционные (БД будет очищена!)
pnpm typecheck
pnpm build
```

## Архитектура
`src/bot` (хендлеры, middleware, клавиатуры) · `src/domain` (чистая логика: деньги, настройки, домены) ·
`src/services` (БД-сервисы, шифрование, rate limit) · `src/db` · `src/http` · `src/texts` (все тексты).

Безопасность: роль проверяется middleware на каждое обновление (+ `requireAdmin` в админских композерах);
инвайт гасится атомарно в транзакции; `LedgerEntry` и `OrderEvent` защищены от UPDATE/DELETE триггером БД;
деньги — `BigInt` в минимальных единицах; логи без текстов сообщений, ссылок и кодов; работа только в личных чатах.
