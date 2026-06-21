# Repository Health Report

**Repository:** `git@github.com:jrafgan/certification-workflow.git`
**Prepared:** 2026-06-21 · **Initial commit:** `901a729` on `main` · **Status:** ready for first push (not yet pushed)

---

## 1. Security findings

| Check | Result |
|-------|--------|
| 1 finding fixed | **`keys/` was NOT ignored** — the real Google service-account key (`keys/…933d6ba72047.json`) would have been committed. Fixed: `.gitignore` now excludes `keys/*` (keeps `keys/.gitkeep`). |
| `.env` files committed? | **No.** `backend/.env` confirmed `on_disk=yes, tracked=no`. `.gitignore` ignores `.env` + `.env.*` (templates re-included). |
| API keys / OAuth secrets committed? | **No.** Robust scan for `GOCSPX-`, `1//…`, `AIza…`, `BEGIN … PRIVATE KEY` across all tracked files → 0 matches. |
| Google credentials committed? | **No.** Service-account JSON confirmed untracked (`keys/*`). |
| WhatsApp session committed? | **No.** `backend/.wwebjs_auth/`, `.wwebjs_cache/`, `whatsapp_media/` ignored & untracked. |
| Mongo data committed? | **No.** No DB files in the repo (Mongo data lives in Docker volumes / `/var/lib/mongodb`). |
| Templates leak real values? | **No.** `backend/.env.example` & `.env.production.example` contain only placeholders/defaults (`CHANGE_ME`, `admin/admin`). |
| `get-gmail-refresh-token.js` | Reads `GOOGLE_CLIENT_ID/SECRET` from `process.env`; no hardcoded secrets. |

**Verdict: no secrets, keys, credentials, `.env`, WhatsApp session, or Mongo data are committed.**

## 2. Files excluded (gitignored)
- `node_modules/`
- `.env`, `.env.*` (except `*.example` templates)
- `keys/*` (real service-account key) — only `keys/.gitkeep` tracked
- `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*-service-account*.json`, `*credentials*.json`
- `backend/.wwebjs_auth/`, `backend/.wwebjs_cache/`, `backend/whatsapp_media/`
- `backend/uploads/{layouts,originals}/*` (folders kept via `.gitkeep`)
- `backend/logs/*.log`, `*.json` (folder kept via `.gitkeep`)
- `/backups/`, OS junk, IDE dirs
- `.claude/settings.local.json` (excluded by the machine's global git ignore)

## 3. Files included (218 tracked)
| Area | Files |
|------|-------|
| `backend/src` (services, models, routes, middleware, integrations) | 99 |
| `backend/tests` | 21 |
| `backend/scripts` | 15 |
| `docs/` (modules 7 + deployment 3 + structure) | 32 |
| `frontend/` (Control Center UI, login, css/js/views) | ~30 |
| `.github/workflows` (ci, deploy, docker-publish) | 3 |
| Root: `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.env.production.example`, `README.md`, `.gitignore` | — |

## 4. Branch strategy
- **`main`** — production / protected (configure branch protection on GitHub: require CI + review).
- **`develop`** — integration branch for ongoing work.
Both currently at `901a729`. Feature branches → `develop` → `main` via PR.

## 5. CI/CD readiness
- **CI** (`.github/workflows/ci.yml`): unit suites (no DB) + builds both Docker images on every push/PR.
- **GHCR** (`.github/workflows/docker-publish.yml`): builds & pushes `ghcr.io/jrafgan/certification-workflow-{backend,whatsapp}` on `main` + version tags (uses `GITHUB_TOKEN`, `packages: write`).
- **Deploy** (`.github/workflows/deploy.yml`): SSH to the VPS, pull + rebuild + health-check on a `vX.Y.Z` tag / manual dispatch.

## 6. Deployment readiness
- Docker stack (`docker-compose.yml`): nginx + backend + mongo + whatsapp + certbot — provider-independent.
- One-command bootstrap, SSL init, backup/restore scripts present (`deploy/`).
- See [DEPLOYMENT.md](DEPLOYMENT.md), [BACKUP_RESTORE.md](BACKUP_RESTORE.md), [PRODUCTION_CHECKLIST.md](PRODUCTION_CHECKLIST.md).

## 7. Required to push (operator action — auth needed)
The repository is **not pushed** (GitHub authentication required — a deliberate stop point):
```bash
# from the repo root, with an SSH key authorized on the jrafgan GitHub account:
git push -u origin main
git push -u origin develop
```
After push: set `main` as default, enable branch protection, and add the deploy secrets
(`SSH_HOST`, `SSH_USER`, `SSH_KEY`, optional `SSH_PORT`/`APP_DIR`).
