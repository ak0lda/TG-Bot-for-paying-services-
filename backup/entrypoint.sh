#!/bin/bash
set -Eeuo pipefail
: "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT (публичный ключ age) обязателен}"

# cron не передаёт окружение — сохраняем нужные переменные для backup.sh (файл доступен только root).
umask 077
env | grep -E '^(POSTGRES_|BACKUP_|RCLONE_|TZ=)' | while IFS='=' read -r k v; do printf 'export %s=%q\n' "$k" "$v"; done >/etc/backup.env

echo "${BACKUP_CRON:-30 3 * * *} /usr/local/bin/backup.sh >>/proc/1/fd/1 2>>/proc/1/fd/2" >/etc/crontabs/root
# Первый бэкап сразу после запуска — чтобы проверить, что всё работает, не дожидаясь ночи.
( sleep 30; /usr/local/bin/backup.sh ) >>/proc/1/fd/1 2>>/proc/1/fd/2 &
exec crond -f -l 8
