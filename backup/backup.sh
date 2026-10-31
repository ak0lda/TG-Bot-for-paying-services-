#!/bin/bash
# Ежедневный бэкап БД: pg_dump -> gzip (+проверка) -> шифрование age -> ротация -> (по желанию) выгрузка наружу через rclone.
# Результат фиксируется в «сердцебиении» для бота: $BACKUP_DIR/.last_success и .last_failure («<unix-время> <деталь>»).
# В логи и файлы сердцебиения не попадают ни пароли, ни содержимое БД.
set -Eeuo pipefail

[ -f /etc/backup.env ] && . /etc/backup.env # cron не наследует окружение контейнера

: "${POSTGRES_HOST:?}" "${POSTGRES_DB:?}" "${POSTGRES_USER:?}" "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT (публичный ключ age) обязателен}"
DIR="${BACKUP_DIR:-/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
REMOTE="${BACKUP_RCLONE_REMOTE:-}"
export PGPASSWORD="${POSTGRES_PASSWORD:-}"

mkdir -p "$DIR/daily"
ts="$(date -u +%Y%m%d-%H%M%S)"
tmp="$DIR/daily/.tmp-$ts.sql.gz"
out="$DIR/daily/${POSTGRES_DB}-$ts.sql.gz.age"

fail() {
  echo "$(date +%s) $1" >"$DIR/.last_failure"
  echo "BACKUP FAILED: $1" >&2
  rm -f "$tmp"
  exit 1
}

pg_dump -h "$POSTGRES_HOST" -p "${POSTGRES_PORT:-5432}" -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges 2>/dev/null \
  | gzip -9 >"$tmp" || fail "pg_dump failed"
gzip -t "$tmp" || fail "gzip integrity check failed"
size="$(wc -c <"$tmp")"
[ "$size" -gt 1024 ] || fail "dump is suspiciously small (${size} bytes)"

age -r "$BACKUP_AGE_RECIPIENT" -o "$out" "$tmp" || { rm -f "$out"; fail "encryption failed"; }
rm -f "$tmp"
[ -s "$out" ] || fail "encrypted file is empty"

# Локальная ротация.
find "$DIR/daily" -maxdepth 1 -name '*.sql.gz.age' -mtime +"$KEEP_DAYS" -delete
find "$DIR/daily" -maxdepth 1 -name '.tmp-*' -mmin +120 -delete

# Копия во внешнее хранилище (S3-совместимое и др.) — файл уже зашифрован, ключ шифрования туда не уходит.
if [ -n "$REMOTE" ]; then
  rclone copyto "$out" "$REMOTE/$(basename "$out")" >/dev/null 2>&1 || fail "offsite upload failed (local copy kept: $(basename "$out"))"
  rclone delete --min-age "${KEEP_DAYS}d" --include '*.sql.gz.age' "$REMOTE" >/dev/null 2>&1 || echo "warning: remote rotation failed" >&2
fi

echo "$(date +%s) $(basename "$out") ${size}" >"$DIR/.last_success"
echo "backup ok: $(basename "$out")"

# Внешний «пульс» бэкапа (dead man's switch): если бэкапы перестанут приходить, мониторинг напишет сам. URL секретный — не логируем.
if [ -n "${BACKUP_HEARTBEAT_URL:-}" ]; then
  curl -fsS -m 10 -o /dev/null "$BACKUP_HEARTBEAT_URL" >/dev/null 2>&1 || echo "warning: heartbeat ping failed" >&2
fi
