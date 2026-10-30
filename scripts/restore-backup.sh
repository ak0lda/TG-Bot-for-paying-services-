#!/usr/bin/env bash
# Восстановление зашифрованного бэкапа в БАЗУ:
#   scripts/restore-backup.sh <backup.sql.gz.age> <файл-с-приватным-ключом-age> <DATABASE_URL>
# Целевая база должна быть пустой (иначе скрипт остановится); принудительно: FORCE=1.
# Нужны age, gunzip, psql. Приватный ключ age хранится ВНЕ сервера (бэкап без него не расшифровать).
set -Eeuo pipefail
FILE="${1:?backup file}"; KEY="${2:?age identity file}"; URL="${3:?DATABASE_URL}"
[ -r "$FILE" ] && [ -r "$KEY" ] || { echo "нет доступа к файлу бэкапа или ключу" >&2; exit 2; }

existing="$(psql -At "$URL" -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
if [ "$existing" != "0" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "В целевой базе уже есть таблицы ($existing). Восстановление — только в пустую базу (или FORCE=1)." >&2
  exit 3
fi
age -d -i "$KEY" "$FILE" | gunzip | psql -q -v ON_ERROR_STOP=1 "$URL" >/dev/null
echo "✔ восстановлено: $(basename "$FILE")"
