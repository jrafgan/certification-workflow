# Runbook: VPS bootstrap & CI/CD enablement (AdminVPS)

Target: `<VPS_IP>` · Ubuntu 24.04 · hostname `dokumenty-agent` · deploy user `max`.
**Key-based SSH only. No passwords.** Ports 22/80/443 are open on AdminVPS (not in their blocked list).

## Keys involved (3 keypairs, each with a clear job)
| Key | Private held by | Public goes to | Purpose |
|-----|-----------------|----------------|---------|
| `cw_deploy` | this terminal (`~/.ssh/cw_deploy`) | VPS `max` authorized_keys | I operate the VPS (bootstrap/deploy) |
| `cw_cicd` | GitHub Secret `SSH_KEY` | VPS `max` authorized_keys | GitHub Actions deploys (CD) |
| `vps_repo` | VPS (`/home/max/.ssh/id_ed25519`) | GitHub repo **Deploy keys** (read-only) | VPS pulls the private repo |

My `cw_deploy` **public** key (add this to the VPS):
```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBzCzTkppG3TLL7ZY9Ty4Q5FPteMEb4qVZIhKEXlc0Qy cw-deploy
```

---

## 1 + 2. On the VPS — create `max` + SSH key auth (run as root)
```bash
# --- create the deploy user, give it sudo ---
adduser --disabled-password --gecos "" max
usermod -aG sudo max
echo 'max ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/90-max && chmod 440 /etc/sudoers.d/90-max

# --- install Docker Engine + Compose plugin + git + nginx tools ---
apt-get update -y
apt-get install -y ca-certificates curl git ufw
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
usermod -aG docker max            # max runs docker without sudo

# --- SSH key auth for max: install BOTH cw_deploy and cw_cicd public keys ---
install -d -m 700 -o max -g max /home/max/.ssh
cat >> /home/max/.ssh/authorized_keys <<'KEYS'
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBzCzTkppG3TLL7ZY9Ty4Q5FPteMEb4qVZIhKEXlc0Qy cw-deploy
# <<< paste the cw_cicd PUBLIC key here (generated in step 3) >>>
KEYS
chmod 600 /home/max/.ssh/authorized_keys
chown max:max /home/max/.ssh/authorized_keys

# --- firewall: SSH + HTTP + HTTPS only ---
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && yes | ufw enable

# --- app dir owned by max ---
install -d -o max -g max /opt/certification-workflow
```

### Harden SSH (do this only AFTER you've confirmed key login works — see Verify)
```bash
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
systemctl reload ssh
```

### Auto-restart & log rotation
- **Auto-restart**: handled by `restart: unless-stopped` on every service in `docker-compose.yml` + `systemctl enable docker` (containers come back on reboot).
- **Docker log rotation** (prevents disk fill):
```bash
cat > /etc/docker/daemon.json <<'JSON'
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }
JSON
systemctl restart docker
```

---

## 3. Configure GitHub Secrets (run locally, where this repo is)
Generate the CI key and store the **private** half straight into the secret (never printed):
```bash
ssh-keygen -t ed25519 -f ~/.ssh/cw_cicd -N "" -C "cw-cicd" -q
cat ~/.ssh/cw_cicd.pub        # <-- paste THIS into the VPS authorized_keys (step 2)
```
Then set the repo secrets — with the GitHub CLI (`gh auth login` first):
```bash
gh secret set SSH_HOST --repo jrafgan/certification-workflow --body "<VPS_IP>"
gh secret set SSH_USER --repo jrafgan/certification-workflow --body "max"
gh secret set SSH_PORT --repo jrafgan/certification-workflow --body "22"
gh secret set APP_DIR  --repo jrafgan/certification-workflow --body "/opt/certification-workflow"
gh secret set SSH_KEY  --repo jrafgan/certification-workflow < ~/.ssh/cw_cicd   # private key, never echoed
```
Or via the web UI: **Settings → Secrets and variables → Actions → New repository secret** for each of
`SSH_HOST`, `SSH_USER`, `SSH_PORT`, `APP_DIR`, and `SSH_KEY` (paste the contents of `~/.ssh/cw_cicd`).

---

## 4. Enable CI/CD deployment from GitHub Actions
The VPS must be able to pull the private repo. On the VPS **as max**:
```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N "" -C "vps-repo" -q
cat ~/.ssh/id_ed25519.pub      # add to GitHub → repo → Settings → Deploy keys (read-only, NO write)
git clone git@github.com:jrafgan/certification-workflow.git /opt/certification-workflow
cd /opt/certification-workflow
cp .env.production.example .env   # then fill it in (secrets, domain)
mkdir -p keys                     # put service-account.json here
```
Now the deploy workflow (`.github/workflows/deploy.yml`) works: on a `vX.Y.Z` tag (or manual
**Run workflow**), GitHub Actions SSHes in as `max` with `cw_cicd`, pulls, `docker compose up -d --build`,
and health-checks. The GHCR publish workflow already runs on `main` with no extra secrets.

---

## Verify (before hardening SSH!)
From this terminal:
```bash
ssh -i ~/.ssh/cw_deploy max@<VPS_IP> 'whoami && docker --version && docker compose version'
```
If that prints `max` + versions, key auth works — then run the SSH-hardening block, and hand back
to me to run the deployment (Phase 4) and HTTPS (Phase 5).
