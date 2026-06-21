# Production Environment Checklist

Tick every box before going live. Grouped by concern.

## DNS & TLS
- [ ] Domain A record points to the AdminVPS IP (propagated: `dig +short <domain>`).
- [ ] `DOMAIN` and `LETSENCRYPT_EMAIL` set in `.env`.
- [ ] `deploy/init-letsencrypt.sh` run; `https://<domain>` shows a valid cert (not the self-signed placeholder).
- [ ] Auto-renewal works: `docker compose logs certbot` shows the renew loop.

## Secrets & config
- [ ] `.env` created from `.env.production.example` and **not** committed.
- [ ] `SESSION_SECRET` = 32+ random chars (`openssl rand -hex 32`).
- [ ] `MONGO_ROOT_PASSWORD` strong and unique.
- [ ] `ADMIN_PASSWORD` changed from default; **changed again after first login**.
- [ ] Google OAuth (`GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN`) valid; Gmail reachable (Data Sources panel shows "подключено").
- [ ] Service-account JSON placed at `keys/service-account.json`; Declaration + New Form sheets shared with that service-account email.
- [ ] `keys/` and `.env` copied to a safe offline location.

## Security
- [ ] Firewall: only 22, 80, 443 open (`ufw status`).
- [ ] SSH: key-based auth only; root password login disabled.
- [ ] MongoDB has **no published port** (internal network only — confirm `docker compose ps` shows no 27017 mapping).
- [ ] A dedicated non-root deploy user in the `docker` group (used by CI/CD `SSH_USER`).
- [ ] No anonymous access: hitting `/api/control-center/summary` without a session returns 401.

## Application
- [ ] Stack healthy: `docker compose ps` all `healthy`/`running`.
- [ ] `GET /health` returns `db: connected`.
- [ ] Log in as admin; create real **operator** and **administrator** accounts; disable/replace the seed admin.
- [ ] Data Sources panel reviewed: Declaration/New Form/Gmail/KB green; WhatsApp expected state understood.
- [ ] Russian UI renders correctly (labels, statuses, audit log).
- [ ] An approve/reject action appears in the **Журнал действий** (audit log) with before/after.

## WhatsApp agent (if enabled)
- [ ] `TEST_MODE=true` for initial rollout; `WHATSAPP_TEST_CONTACT` set.
- [ ] QR scanned once; `wa_auth` volume persists the session across `docker compose restart whatsapp`.
- [ ] Only ONE backend instance runs (the cron scheduler is in-process — do not scale `backend` horizontally without externalizing cron).

## Backups & recovery
- [ ] `deploy/backup.sh` runs successfully and produces a tarball.
- [ ] Daily backup cron installed.
- [ ] Backups copied **off-server** (rclone/scp to another location).
- [ ] A restore has been tested at least once on a throwaway host.

## CI/CD
- [ ] CI green on `main` (tests + image builds).
- [ ] Deploy secrets set: `SSH_HOST`, `SSH_USER`, `SSH_KEY` (+ `SSH_PORT`/`APP_DIR` if non-default).
- [ ] `production` GitHub environment has required reviewers (manual approval gate) if desired.
- [ ] A tag deploy (`vX.Y.Z`) succeeds end-to-end and the health gate passes.

## Operability
- [ ] Log rotation acceptable (Docker `json-file` default; consider `max-size`/`max-file` in daemon.json on small disks).
- [ ] Disk usage monitored (`df -h`) — WhatsApp media + Mongo + backups grow over time.
- [ ] Timezone correct for the scheduler (`SCHEDULER_TIMEZONE`, e.g. `Asia/Bishkek`).
