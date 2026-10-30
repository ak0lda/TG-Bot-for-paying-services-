#!/usr/bin/env bash
# Проверка, что зашифрованный бэкап РЕАЛЬНО восстанавливается: расшифровка -> временная БД -> ключевые таблицы на месте.
#   scripts/verify-encrypted-backup.sh <backup.sql.gz.age> <файл-с-приватным-ключом-age> <postgres-URL-без-имени-БД>
# Пример: scripts/verify-encrypted-backup.sh backups/daily/bot-....age ~/age-key.txt postgresql://bot:pass@localhost:5432
set -Eeuo pipefail
FILE="${1:?backup file}"; KEY="${2:?age identity file}"; BASE="${3:?postgres base URL}"
TMP_DB="bot_verify_$$"
trap 'psql "$BASE/postgres" -qc "DROP DATABASE IF EXISTS \"$TMP_DB\"" >/dev/null 2>&1 || true' EXIT

psql "$BASE/postgres" -qc "CREATE DATABASE \"$TMP_DB\"" >/dev/null
"$(dirname "$0")/restore-backup.sh" "$FILE" "$KEY" "$BASE/$TMP_DB"

for t in User Order OrderEvent LedgerEntry Setting _prisma_migrations; do
  psql -At "$BASE/$TMP_DB" -c "SELECT count(*) FROM \"$t\"" >/dev/null || { echo "✘ нет таблицы $t" >&2; exit 1; }
done
echo "✔ бэкап пригоден: таблицы на месте"
psql -At "$BASE/$TMP_DB" -c "SELECT 'пользователей: '||(SELECT count(*) FROM \"User\")||', заявок: '||(SELECT count(*) FROM \"Order\")||', проводок: '||(SELECT count(*) FROM \"LedgerEntry\")"
