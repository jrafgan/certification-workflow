#!/usr/bin/env bash
# One-command bootstrap for a CLEAN Ubuntu 24.04 LTS AdminVPS server.
# Installs Docker + Compose, prepares the app, and brings the stack up.
#
#   curl -fsSL https://raw.githubusercontent.com/<org>/<repo>/main/deploy/bootstrap-vps.sh | sudo bash
# or, with the repo already cloned:
#   sudo bash deploy/bootstrap-vps.sh
#
# Idempotent: safe to re-run. Provider-independent — nothing here is AdminVPS-specific.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/your-org/certification-workflow.git}"
APP_DIR="${APP_DIR:-/opt/certification-workflow}"
BRANCH="${BRANCH:-main}"

echo "==> 1/5 System packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl git ufw

echo "==> 2/5 Docker Engine + Compose plugin"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker

echo "==> 3/5 Firewall (SSH + HTTP + HTTPS only)"
ufw allow OpenSSH || true
ufw allow 80/tcp  || true
ufw allow 443/tcp || true
yes | ufw enable   || true

echo "==> 4/5 Application code at ${APP_DIR}"
if [ ! -d "${APP_DIR}/.git" ]; then
  git clone --branch "${BRANCH}" "${REPO_URL}" "${APP_DIR}"
else
  git -C "${APP_DIR}" pull --ff-only
fi
cd "${APP_DIR}"

if [ ! -f .env ]; then
  cp .env.production.example .env
  echo
  echo "!!  Created ${APP_DIR}/.env from the template."
  echo "!!  EDIT IT NOW (domain, Mongo password, SESSION_SECRET, Google creds), then run:"
  echo "!!     cd ${APP_DIR} && sudo bash deploy/init-letsencrypt.sh && docker compose up -d --build"
  exit 0
fi

echo "==> 5/5 Build & start the stack"
mkdir -p keys
docker compose up -d --build
echo
echo "Done. Issue TLS certs (once):  sudo bash ${APP_DIR}/deploy/init-letsencrypt.sh"
echo "Then open: https://$(grep -E '^DOMAIN=' .env | cut -d= -f2)"
