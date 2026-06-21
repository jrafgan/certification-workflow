#!/usr/bin/env bash
# Restore strategy — rebuild state from a backup tarball produced by backup.sh.
#
#   sudo bash deploy/restore.sh ./backups/backup-20260621-033000.tar.gz
#
# Restores: MongoDB (drop + reload), WhatsApp session, uploads. The stack must be up
# (at least mongo). This OVERWRITES current data — confirm before running in production.
set -euo pipefail
cd "$(dirname "$0")/.."

ARCHIVE="${1:-}"
[ -n "$ARCHIVE" ] && [ -f "$ARCHIVE" ] || { echo "Usage: restore.sh <backup.tar.gz>"; exit 1; }

source .env 2>/dev/null || true
DB="${MONGO_DB:-certification-workflow}"

read -r -p "This will OVERWRITE the '$DB' database and WhatsApp session. Type 'yes' to continue: " ok
[ "$ok" = "yes" ] || { echo "Aborted."; exit 1; }

STAGE="$(mktemp -d)"
tar xzf "$ARCHIVE" -C "$STAGE"

echo "==> Ensure mongo is up"
docker compose up -d mongo
sleep 3

echo "==> mongorestore ($DB) — dropping existing collections first"
docker compose exec -T mongo sh -c \
  "mongorestore --username \"$MONGO_ROOT_USERNAME\" --password \"$MONGO_ROOT_PASSWORD\" --authenticationDatabase admin --db \"$DB\" --drop --archive --gzip" \
  < "$STAGE/mongo-$DB.archive.gz"

if [ -f "$STAGE/wa_auth.tgz" ]; then
  echo "==> Restore WhatsApp session"
  docker run --rm -v certification-workflow_wa_auth:/v -v "$STAGE":/in alpine \
    sh -c "cd /v && rm -rf ./* && tar xzf /in/wa_auth.tgz"
fi
if [ -f "$STAGE/uploads.tgz" ]; then
  echo "==> Restore uploads"
  docker run --rm -v certification-workflow_uploads:/v -v "$STAGE":/in alpine \
    sh -c "cd /v && tar xzf /in/uploads.tgz"
fi

rm -rf "$STAGE"
echo "==> Restart services to pick up restored state"
docker compose up -d --build
echo "Done."
