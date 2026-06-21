#!/usr/bin/env bash
# Issue the first Let's Encrypt certificate (run ONCE per domain).
# Solves the chicken-and-egg problem: nginx needs a cert to start, but certbot needs
# nginx (port 80) to answer the ACME challenge. We drop a temporary self-signed cert so
# nginx starts, then replace it with the real one via the webroot challenge.
#
#   sudo bash deploy/init-letsencrypt.sh
set -euo pipefail
cd "$(dirname "$0")/.."

DOMAIN="$(grep -E '^DOMAIN=' .env | cut -d= -f2)"
EMAIL="$(grep -E '^LETSENCRYPT_EMAIL=' .env | cut -d= -f2)"
STAGING="${STAGING:-0}"   # set STAGING=1 to test against Let's Encrypt staging first

[ -n "$DOMAIN" ] || { echo "DOMAIN missing in .env"; exit 1; }
echo "==> Domain: $DOMAIN"

LIVE=/etc/letsencrypt/live/$DOMAIN
echo "==> Temporary self-signed cert so nginx can start"
docker compose run --rm --entrypoint sh certbot -c "\
  mkdir -p $LIVE && \
  openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
    -keyout $LIVE/privkey.pem -out $LIVE/fullchain.pem -subj '/CN=$DOMAIN'"

echo "==> Start nginx (serves the ACME challenge over :80)"
docker compose up -d nginx

echo "==> Request the real certificate"
STAGING_FLAG=""; [ "$STAGING" = "1" ] && STAGING_FLAG="--staging"
docker compose run --rm --entrypoint certbot certbot certonly \
  --webroot -w /var/www/certbot \
  -d "$DOMAIN" --email "$EMAIL" --agree-tos --no-eff-email \
  --force-renewal $STAGING_FLAG

echo "==> Reload nginx with the real cert"
docker compose exec nginx nginx -s reload || docker compose restart nginx
echo "Done. Auto-renewal runs in the certbot container (every 12h)."
