# Runbooks

Operational, step-by-step procedures for running the system in production. Keep each runbook
short and action-oriented (symptoms → exact commands → verification).

Planned / available runbooks:
- **Restore from backup** → see [../deployment/BACKUP_RESTORE.md](../deployment/BACKUP_RESTORE.md)
- **Issue / renew SSL** → `deploy/init-letsencrypt.sh`; renewal runs in the certbot container
- **Rotate the admin password** → log in as admin → Пользователи → create a new admin → disable the old
- **WhatsApp not receiving** → check the Meta Cloud API webhook (`/webhooks/whatsapp`) and `[wa-cloud]` lines in `docker compose logs -f backend`
- **Database offline** → the Control Center keeps serving and shows "База недоступна"; restart `mongo`, check `/health`

Add a dedicated file per procedure as incidents occur (e.g. `runbooks/restore.md`).
