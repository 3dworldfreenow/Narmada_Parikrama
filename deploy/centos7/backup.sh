#!/usr/bin/env bash
# Daily backup of the database and uploads. Add to root's crontab:
#   15 2 * * * bash /opt/narmada/deploy/centos7/backup.sh
set -euo pipefail
DEST=/var/backups/narmada; mkdir -p "$DEST"
STAMP=$(date +%F)
sqlite3 /var/lib/narmada/narmada.db ".backup '$DEST/narmada-$STAMP.db'" 2>/dev/null \
  || cp /var/lib/narmada/narmada.db "$DEST/narmada-$STAMP.db"
tar -czf "$DEST/uploads-$STAMP.tar.gz" -C /var/lib/narmada uploads
find "$DEST" -type f -mtime +14 -delete     # keep two weeks
