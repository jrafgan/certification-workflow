# Deployment Guide — AdminVPS (provider-independent)

```
GitHub  ──►  GitHub Actions (CI: tests + image build)  ──►  AdminVPS (SSH)  ──►  Docker stack
                                                                                  ├─ nginx (80/443, Let's Encrypt SSL)
                                                                                  ├─ backend  (API + Agent Control Center + OCR + Gmail + KB + Lead/Workflow engines)
                                                                                  ├─ whatsapp (WhatsApp Agent, optional)
                                                                                  └─ mongo    (database)
```

Everything is standard Docker + Compose. Nothing is AdminVPS-specific — the exact same
stack runs on Hetzner, a laptop, or any Ubuntu host. **Migration = copy `.env` + a backup
tarball to a new server and run two commands** (see Migration below).

---

## 0. Prerequisites
- A clean **Ubuntu 24.04 LTS** AdminVPS server with root/sudo SSH access.
- A **domain** (e.g. `panel.dokumenty.pro`) with an **A record → the server's IP**.
- Google credentials (OAuth refresh token for Gmail; service-account JSON for Sheets).

## 1. One-command bootstrap
On the fresh server:
```bash
curl -fsSL https://raw.githubusercontent.com/<org>/<repo>/main/deploy/bootstrap-vps.sh | sudo bash
```
This installs Docker + Compose, opens the firewall (22/80/443), clones the repo to
`/opt/certification-workflow`, and creates `.env` from the template. It then **stops** so
you can fill in `.env`.

## 2. Configure
```bash
cd /opt/certification-workflow
sudo nano .env                       # domain, Mongo password, SESSION_SECRET, Google creds
sudo cp /path/to/service-account.json keys/service-account.json   # Sheets key (if used)
```
Generate strong secrets: `openssl rand -hex 32` (SESSION_SECRET), and a long MONGO password.

## 3. Issue SSL + start
```bash
sudo bash deploy/init-letsencrypt.sh      # one-time: obtains the Let's Encrypt certificate
docker compose up -d --build              # start the core stack
```
Open `https://<your-domain>` → log in with `ADMIN_USERNAME` / `ADMIN_PASSWORD`, then
**change the admin password and create real operator accounts**.

## 4. Enable the WhatsApp agent (when ready)
```bash
docker compose --profile whatsapp up -d --build
docker compose logs -f whatsapp           # scan the printed QR with the business phone (once)
```
The session persists in the `wa_auth` volume — restarts won't re-prompt. Keep
`TEST_MODE=true` until you've verified behaviour on the live number.

## 5. Continuous deployment (optional)
Add repo secrets `SSH_HOST`, `SSH_USER`, `SSH_KEY` (+ optional `SSH_PORT`, `APP_DIR`).
Pushing a `vX.Y.Z` tag (or running the **Deploy** workflow) SSHes in, pulls, rebuilds, and
health-checks — only after CI passes.

---

## Server sizing

The heaviest component is the **WhatsApp agent's headless Chromium** (one instance,
regardless of operator count — there is one business number). MongoDB's working set for
this business is small (thousands of rows). Operator count mainly affects concurrent web
sessions (light internal tool) and OCR/message throughput. So scaling is gentle.

| Operators | vCPU | RAM | SSD | Notes |
|-----------|------|-----|-----|-------|
| **1–3**   | 2    | **4 GB**  | 50 GB  | Comfortable: Mongo + backend + Chromium + nginx. OCR bursts CPU briefly. |
| **5**     | 2–4  | **8 GB**  | 80 GB  | Headroom for more concurrent OCR + media growth. |
| **10**    | 4    | **16 GB** | 160 GB | Concurrency headroom; consider a managed/replica Mongo and off-host backups. |

Approx. steady-state RAM: Mongo ~0.5–1 GB · backend ~0.2–0.3 GB · WhatsApp+Chromium
~0.5–0.7 GB · nginx/certbot negligible. **4 GB is the practical floor** because of
Chromium. Storage is dominated by WhatsApp media + Mongo + local backups — size SSD for
media retention, and copy backups off-server.

If you won't run the WhatsApp agent on the box, 2 vCPU / 2 GB is enough for 1–3 operators.

---

## Operations
```bash
docker compose ps                     # status
docker compose logs -f backend        # tail logs (or nginx / whatsapp / mongo)
docker compose up -d --build          # apply code/config changes
docker compose restart nginx          # reload after editing nginx.conf.template
docker compose down                   # stop (data persists in named volumes)
```

## Migration to another provider (provider-independent)
1. On the new Ubuntu host: run the bootstrap (step 1) and copy your `.env` + `keys/`.
2. Copy the latest `backups/backup-*.tar.gz` over and `sudo bash deploy/restore.sh <file>`.
3. `sudo bash deploy/init-letsencrypt.sh` (after pointing DNS at the new IP) and
   `docker compose up -d --build`.
No data lives outside named Docker volumes + `.env` + `keys/`, so there is no lock-in.

See also: [BACKUP_RESTORE.md](BACKUP_RESTORE.md) and [PRODUCTION_CHECKLIST.md](PRODUCTION_CHECKLIST.md).
