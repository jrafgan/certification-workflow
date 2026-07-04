# Runbook — Migrate deployment off the RU VPS (Meta-blocked) to a non-RU host

**Date:** 2026-06-24
**Why:** the current AdminVPS (`79.133.181.231`, Russian host) has Meta + Telegram
network-blocked both directions (provider/state level, not local firewall). WhatsApp
Cloud API cannot work there — Meta's webhook verification never reaches the server, and the
server can't reach `graph.facebook.com` to send. See memory `meta-blocked-on-ru-vps`.
Google/Cloudflare egress works fine, so only Meta/Telegram are affected.

The deploy kit is provider-independent (Docker/Compose/nginx/Mongo/LE), so this is a copy +
re-point, not a rewrite.

---

## 0. Operator action (cannot be automated — needs your hosting account)

Provision a fresh **Ubuntu 24.04 LTS** VPS **outside Russia** (and outside other
Meta-blocking jurisdictions). Good low-latency-to-Meta, unblocked options:
- **Hetzner** (Falkenstein/Nuremberg DE, Helsinki FI) — cheap, reliable.
- **DigitalOcean / Vultr / Linode** (Amsterdam, Frankfurt, London).
- **Contabo** (EU).

Sizing (same as current kit): **2 vCPU / 4 GB / 50 GB** is the practical floor (Chromium
for the legacy WA client; the Cloud API path itself is light). 4 GB if not running the
headless WA agent.

Give me: the **new IP** + **SSH access** (add the existing key
`~/.ssh/cw_deploy.pub`, or generate a new one and share). Keep the RU box running until
cutover is verified.

---

## 1. PRE-FLIGHT (the decisive test — run BEFORE migrating anything)

On the new box, confirm Meta is actually reachable (don't migrate onto another blocked host):
```bash
curl -sS -m 10 -o /dev/null -w "graph: %{http_code}\n" https://graph.facebook.com/v21.0/
# expect a non-000 HTTP code (400/401 is fine — means connected). 000/timeout = still blocked, pick another host.
curl -sS -m 10 -o /dev/null -w "telegram: %{http_code}\n" https://api.telegram.org
```
Only proceed if `graph.facebook.com` connects.

## 2. Bring up the stack on the new host
```bash
curl -fsSL https://raw.githubusercontent.com/<org>/<repo>/main/deploy/bootstrap-vps.sh | sudo bash
# then copy over from the RU box (or from local): .env  and  keys/
```
- Copy `.env` as-is (Mongo creds, SESSION_SECRET, all `WHATSAPP_*`). **Note:** the temp
  `WHATSAPP_CLOUD_TOKEN` (EAA…, 24 h) will have expired — replace with a fresh token (ideally
  a **permanent System User token**: perms `whatsapp_business_messaging` +
  `whatsapp_business_management`).
- Set `DOMAIN=dokumenty.win`, `LETSENCRYPT_EMAIL=...`.
- **Remove** the MVP override if copied (the new host should run nginx+certbot, not pin
  backend to :80).

## 3. Migrate data (Mongo)
```bash
# on RU box:   sudo bash deploy/backup.sh   → backups/backup-*.tar.gz
# copy tarball to new box, then:
sudo bash deploy/restore.sh backups/backup-XXXX.tar.gz
```

## 4. Cutover DNS (Cloudflare)
- Change the `dokumenty.win` **A record → NEW IP**, keep **grey cloud (DNS only)**.
- TTL is low on Cloudflare; propagation is minutes.

## 5. TLS + start
```bash
sudo bash deploy/init-letsencrypt.sh     # re-issue LE cert for dokumenty.win on the new IP
docker compose up -d --build
```
(Known gotcha from last time: if init-letsencrypt's temp self-signed lineage blocks certbot,
`rm -rf live/archive/renewal` for the domain then `certbot certonly --webroot`.)

## 6. Verify end-to-end (this is what FAILED on the RU box and should now PASS)
```bash
# inbound reachability:
curl -sS "https://dokumenty.win/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=certification_workflow_2026&hub.challenge=ok"  # → ok
# outbound to Meta FROM the server (the RU box could NOT do this):
TOKEN=$(grep ^WHATSAPP_CLOUD_TOKEN= .env|cut -d= -f2-); WABA=$(grep ^WHATSAPP_BUSINESS_ACCOUNT_ID= .env|cut -d= -f2-)
curl -sS -X POST "https://graph.facebook.com/v21.0/$WABA/subscribed_apps" -H "Authorization: Bearer $TOKEN"   # → {"success":true}
```
Then in Meta → WhatsApp → Configuration: **Verify and save** (now Meta's GET will actually
reach us → tail `nginx` logs for `facebookexternalua`), subscribe to field `messages`, and
send a `hello_world` test from the server.

## 7. Decommission RU box
After cutover is verified working for a day, stop/snapshot/cancel the RU VPS.

---

## What stays the same
DNS provider (Cloudflare), domain (`dokumenty.win`), all Meta IDs already in `.env`
(`PHONE_NUMBER_ID=1183666431496291`, `BUSINESS_ACCOUNT_ID=1747233966620282`,
`APP_ID=1015102374853736`, `APP_SECRET`, `VERIFY_TOKEN=certification_workflow_2026`). Only the
host IP and the (expired) cloud token change.
