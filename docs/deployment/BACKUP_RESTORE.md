# Backup & Restore

## What matters
| Data | Where | Backed up? | Notes |
|------|-------|-----------|-------|
| Business state (orders, leads, drafts, audit log, users, KB cache) | MongoDB (`mongo_data` volume) | **Yes** | Captured by `mongodump`. |
| WhatsApp login session | `wa_auth` volume | **Yes** | Avoids re-scanning the QR after restore. |
| Uploaded receipts/layouts/originals | `uploads` volume | **Yes** | Local files. |
| Declaration sheet, Knowledge Base source | Google (Sheets) | External | Mongo is a replica; Google is the source of truth for those. |
| Secrets / config | `.env`, `keys/` | **Manual** | Copy these off-server yourself; they are not in the tarball except an `.env.snapshot`. |

## Backup
```bash
sudo bash deploy/backup.sh           # → ./backups/backup-YYYYMMDD-HHMMSS.tar.gz
```
- Self-contained tarball: Mongo archive (gzipped) + `wa_auth` + `uploads` + `.env.snapshot`.
- **Automate (daily 03:30, keep 14 days):**
  ```cron
  30 3 * * * cd /opt/certification-workflow && bash deploy/backup.sh >> /var/log/cw-backup.log 2>&1
  ```
- **Off-site copy (do this!):** a backup on the same server is not disaster recovery. Push
  to object storage or another host, e.g.:
  ```bash
  rclone copy ./backups remote:cw-backups        # or scp to a second box
  ```
- Tune retention/location with env: `RETENTION_DAYS`, `BACKUP_DIR`.

## Restore
```bash
sudo bash deploy/restore.sh ./backups/backup-YYYYMMDD-HHMMSS.tar.gz
```
- Prompts for confirmation (it **drops** and reloads the database).
- Restores Mongo, the WhatsApp session, and uploads, then rebuilds and restarts the stack.
- Restoring onto a new server is the migration path — see DEPLOYMENT.md → Migration.

## Verify a backup (recommended quarterly)
Restore the latest tarball onto a throwaway VM and confirm you can log in and see data.
An untested backup is a hope, not a backup.

## Recovery objectives (defaults)
- **RPO** (max data loss): up to 24h with daily backups — tighten by running `backup.sh`
  more often (it's safe to run hourly; Mongo dump is consistent via `--archive`).
- **RTO** (time to restore): ~10–20 min on a prepared host (bootstrap + restore + certs).
