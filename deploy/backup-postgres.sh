#!/usr/bin/env bash
# pg_dump of the NBshiyan DB only (custom format, compressed) → ${NBSHIYAN_DATA_DIR}/backup. Cron: daily 04:30.
# Retention: 7 daily + 4 weekly (Sunday) + up to 3 pre-deploy dumps. Size cap alert (never deletes beyond retention).
set -Eeuo pipefail; umask 077
: "${NBSHIYAN_DATA_DIR:?}"; B="$NBSHIYAN_DATA_DIR/backup"; kind="${1:-daily}"
CAP_MB="${BACKUP_CAP_MB:-1024}"
[ "$kind" = daily ] && [ "$(date +%u)" = 7 ] && kind=weekly
f="$B/nbshiyan-$kind-$(date +%Y%m%d-%H%M).dump"
docker exec nbshiyan-postgres-1 sh -c 'PGPASSWORD="$(cat /run/secrets/pg_password)" exec pg_dump -U nbshiyan -h 127.0.0.1 -d nbshiyan -Fc -Z 6' > "$f.part"
docker exec -i nbshiyan-postgres-1 pg_restore --list < "$f.part" >/dev/null   # validates the archive
mv "$f.part" "$f"; chmod 600 "$f"
prune() { find "$B" -maxdepth 1 -type f -name "nbshiyan-$1-*.dump" -printf '%T@ %p\n' | sort -rn | tail -n +$(( $2 + 1 )) | cut -d' ' -f2- | xargs -r -d '\n' rm -f; }
prune daily 7; prune weekly 4; prune pre-deploy 3
used=$(du -sm "$B" | cut -f1)
echo "[backup] $(basename "$f") $(du -h "$f" | cut -f1); dir total ${used} MB"
(( used <= CAP_MB )) || { echo "[backup] WARNING: backup dir ${used} MB > cap ${CAP_MB} MB" >&2; exit 3; }
