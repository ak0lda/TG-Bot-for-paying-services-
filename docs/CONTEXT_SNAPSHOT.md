# Context snapshot — конец этапа 1

Дата: 2026-10-09 · Ветка: `claude/tender-galileo-vgpmyi` · Следующий шаг: **этап 2** (ждёт подтверждения владельца).

## Продукт (кратко)
Закрытый TG-бот: друзья создают заявки на оплату зарубежных сервисов, админ платит своей картой вручную, друзья возвращают рубли.
Типы заявок: PAYMENT_LINK, GIFT_CARD (код шифруется AES-256-GCM, удаляется через N дней после DONE), TOP_UP, OTHER.
Режимы оплаты клиента: PREPAY (по умолчанию), BALANCE (резерв с баланса), PAY_LATER (лимит долга).
Логины/пароли и реквизиты карт не запрашиваем и не храним; у карт админа — только метка и валюта.

## Принятые решения (подтверждены владельцем: «по всем пунктам да»)
1. Карточки заявок — в личку админа (`ADMIN_CHAT_ID` опционален). Только русский.
2. BALANCE: резерв суммы расчёта → при DONE резерв превращается в списание, затем отдельной проводкой разница по факту.
3. Факт списания переводится в рубли по курсу ЦБ на момент DONE (админ может поправить вручную); валюта карты ≠ валюта заявки допустима.
4. Разница (переплата/доплата) автоматически идёт в ledger клиента + уведомление клиенту.
5. Отклонение/отмена после подтверждённой оплаты: деньги остаются на балансе клиента (не возврат переводом).
6. Инвайт: одноразовый, 72 ч. PAY_LATER лимит — в рублях. Напоминания 10:00 МСК. Бэкапы 14 дней локально. pnpm. Без лицензии.
7. Хостинг не выбран → по умолчанию **long polling** (домен/HTTPS не нужны), webhook + Caddy — опциональный профиль compose.

## Сделано в этапе 1
- Каркас: pnpm, TS strict (NodeNext, импорты с `.js`), Vitest, Dockerfile, docker-compose (db, app, backup, caddy-профиль), `.env.example`, README.
- `prisma/schema.prisma` — **полная схема всех этапов** (User, Invite, Setting, TrustedDomain, PaymentMethod, AdminCard, Order, OrderEvent, TopUp, Attachment, LedgerEntry, Reminder).
  Миграция `20260101000000_init` + триггеры append-only для `LedgerEntry` и `OrderEvent`. Применена и проверена на реальном PostgreSQL 16.
- Конфиг (Zod, `loadConfig`), логгер pino с redact, `domain/money` (BigInt, парсинг/формат/округление вверх до рубля),
  `services/crypto` (AES-256-GCM, формат iv|tag|ct), `services/rate-limiter` (token bucket 10 + 1/с),
  `domain/settings` (реестр настроек; проценты в б.п., рубли в копейках), `domain/domains`, `domain/invite-code`.
- Сервисы: Users, Invites (атомарное погашение в транзакции), Settings, TrustedDomains; `db/bootstrap` (разово: 5 доверенных доменов + 3 метода оплаты).
- Бот: middleware `rateLimit` → `auth` (роль на каждый апдейт, только приват; неизвестным — только /start; заблокированным — отказ) → `common` (/start [код], /help) → `admin` (с `requireAdmin`):
  /invite, /invites, /clients, /block, /unblock, /paylater, /settings, /domains, /domain_add, /domain_del.
- Fastify: `/health`, `/webhook` (secretToken) только в webhook-режиме. Graceful shutdown.
- Тесты: 51 (46 юнит + 5 интеграционных с БД, включая гонку 3 одновременных погашений одного инвайта и запрет UPDATE/DELETE в ledger). `tsc --noEmit` и `pnpm build` чистые.

## Не проверено
- Реальный запуск с Telegram (нет токена в окружении) и `docker compose up` (в окружении нет Docker-демона). Dockerfile не собирался.
- Интеграционные тесты запускаются только с `TEST_DATABASE_URL` (иначе пропускаются).

## Настройки по умолчанию (меняются через /settings)
fxBufferBp=200 (2%), markupBp=500 (5%), fixedFeeMinor=0, quoteTtlHours=12, staleLinkHours=24, giftCodeRetentionDays=7,
debtReminderDays=3, subscriptionRemindDays=3, inviteTtlHours=72, reminderHour=10, defaultPayLaterLimitMinor=0.

## План этапа 2 (заявки, расчёт, статусы, админ-обработка)
- `domain/link-validator` (https, сокращатели, доверенные домены, поддомены), `domain/pricing` (итог = сумма×курс×(1+запас)×(1+наценка)+фикс, ceil до рубля, Decimal/BigInt),
  `domain/order-fsm` (таблица переходов + роли + guard), `services/rates` (ЦБ XML, кеш 1 ч, ручной курс), `domain/secret-detector`.
- `services/order-service.transition()` — единственная точка смены статуса: optimistic lock по `Order.version`, запись `OrderEvent`, ledger — в одной транзакции.
- Диалог создания заявки по типам (@grammyjs/conversations), «Мои заявки», «Отменить».
- Админ-карточка с кнопками по статусу, идемпотентность кнопок (версия в callback_data), «Выполнено» (карта, факт списания, разница, GIFT_CARD-код), `/cards`.
- Юнит-тесты: pricing, FSM, link-validator, secret-detector.
- Открытый вопрос к владельцу на этап 2: нет (все ответы получены).

## Как продолжить в новой сессии
`pnpm install && pnpm prisma generate`; прочитать этот файл и `prisma/schema.prisma`; для интеграционных тестов поднять PostgreSQL и выставить `TEST_DATABASE_URL`.
