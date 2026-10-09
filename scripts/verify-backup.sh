#!/usr/bin/env bash
# Проверка, что бэкап восстанавливается: pg_dump -> временная БД -> сравнение числа строк во всех таблицах.
# Использование:  DATABASE_URL=postgresql://user:pass@host:5432/bot ./scripts/verify-backup.sh
# Нужны клиенты psql / pg_dump / createdb / dropdb (postgresql-client) с доступом к серверу.
set -euo pipefail

: "${DATABASE_URL:?set DATABASE_URL}"
BASE_URL="${DATABASE_URL%/*}"
SRC_DB="${DATABASE_URL##*/}"; SRC_DB="${SRC_DB%%\?*}"
TMP_DB="${SRC_DB}_verify_$$"
DUMP="$(mktemp)"
trap 'psql "$BASE_URL/postgres" -qc "DROP DATABASE IF EXISTS \"$TMP_DB\"" >/dev/null 2>&1 || true; rm -f "$DUMP"' EXIT

echo "→ дамп $SRC_DB"
pg_dump --no-owner --no-privileges "$DATABASE_URL" >"$DUMP"
echo "→ восстановление в $TMP_DB"
psql "$BASE_URL/postgres" -qc "CREATE DATABASE \"$TMP_DB\"" >/dev/null
psql -q -v ON_ERROR_STOP=1 "$BASE_URL/$TMP_DB" <"$DUMP" >/dev/null

count_rows() {
  psql -At "$1" -c "SELECT string_agg(format('%s=%s', tablename, (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I', tablename), false, true, '')))[1]::text), ' ' ORDER BY tablename) FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'"
}
A="$(count_rows "$DATABASE_URL")"
B="$(count_rows "$BASE_URL/$TMP_DB")"
if [ "$A" = "$B" ]; then
  echo "✔ бэкап восстановлен, количество строк совпадает"
  echo "  $A"
else
  echo "✘ расхождение!"; echo "  источник:     $A"; echo "  восстановлено: $B"; exit 1
fi
