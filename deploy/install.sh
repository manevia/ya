#!/usr/bin/env bash
# AquaTrack one-time server setup for Ubuntu 22.04/24.04 or Debian 12 (amd64 or arm64, e.g. a VPS or a Raspberry Pi 4/5).
#
#   sudo bash install.sh --repo git@github.com:YOUR-ORG/aquatrack.git [--tunnel-token TOKEN] [--branch main] [--demo]
#
# What it does:
#   1. installs Node.js 22, git, unzip and cloudflared
#   2. creates the "aquatrack" system user, /opt/aquatrack (code) and /var/lib/aquatrack (data)
#   3. writes /etc/aquatrack/aquatrack.env with a random encryption key (back this file up!)
#   4. makes a read-only GitHub deploy key and waits while you add it to the repository
#   5. installs the first release (tested before it goes live) and starts AquaTrack on 127.0.0.1:8080
#   6. turns on automatic updates (checks GitHub every 10 minutes) and, with --tunnel-token, the Cloudflare Tunnel
# AquaTrack itself is never exposed directly: only cloudflared, on the same machine, can reach it.
set -euo pipefail
REPO=""; TOKEN=""; BRANCH=main; APPMODE=live
while [ $# -gt 0 ]; do case "$1" in
  --repo) REPO="$2"; shift 2 ;; --tunnel-token) TOKEN="$2"; shift 2 ;; --branch) BRANCH="$2"; shift 2 ;; --demo) APPMODE=demo; shift ;;
  *) echo "unknown option $1"; exit 1 ;; esac; done
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo."; exit 1; }
[ -n "$REPO" ] || { echo "Give the GitHub repository: --repo git@github.com:YOUR-ORG/aquatrack.git"; exit 1; }
step() { echo; echo "==> $*"; }

step "System packages"
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git unzip openssh-client util-linux >/dev/null

step "Node.js 22"
if ! command -v node >/dev/null || ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node --version

step "cloudflared"
if ! command -v cloudflared >/dev/null; then
  install -m 0755 -d /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
  printf '%s\n' 'Types: deb' 'URIs: https://pkg.cloudflare.com/cloudflared' 'Suites: any' 'Components: main' "Architectures: $(dpkg --print-architecture)" 'Signed-By: /usr/share/keyrings/cloudflare-main.gpg' > /etc/apt/sources.list.d/cloudflared.sources
  apt-get update -qq && apt-get install -y -qq cloudflared >/dev/null
fi
cloudflared --version

step "User and folders"
id aquatrack >/dev/null 2>&1 || useradd --system --home /var/lib/aquatrack --shell /usr/sbin/nologin aquatrack
install -d -m 0755 /opt/aquatrack /opt/aquatrack/releases /opt/aquatrack/bin
install -d -m 0750 -o aquatrack -g aquatrack /var/lib/aquatrack
install -d -m 0750 /etc/aquatrack

step "Settings file /etc/aquatrack/aquatrack.env"
if [ ! -f /etc/aquatrack/aquatrack.env ]; then
  umask 077
  cat > /etc/aquatrack/aquatrack.env <<EOF
# AquaTrack settings. Keep a copy of this file somewhere safe: AQ_SECRET_KEY decrypts two-factor secrets.
APP_MODE=$APPMODE
PORT=8080
HOST=127.0.0.1
DATA_DIR=/var/lib/aquatrack
COOKIE_SECURE=1
TRUST_PROXY=cloudflare
AQ_SECRET_KEY=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
REPO_URL=$REPO
BRANCH=$BRANCH
EOF
  chmod 0640 /etc/aquatrack/aquatrack.env; chgrp aquatrack /etc/aquatrack/aquatrack.env
else echo "already exists — kept"; fi
chgrp aquatrack /etc/aquatrack; chmod 0750 /etc/aquatrack

step "GitHub deploy key (read-only)"
if [ ! -f /etc/aquatrack/deploy_key ]; then ssh-keygen -q -t ed25519 -N '' -C "aquatrack-server-$(hostname)" -f /etc/aquatrack/deploy_key; fi
chmod 0600 /etc/aquatrack/deploy_key
export GIT_SSH_COMMAND="ssh -i /etc/aquatrack/deploy_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/etc/aquatrack/known_hosts"
until git ls-remote "$REPO" "refs/heads/$BRANCH" >/dev/null 2>&1; do
  echo; echo "Add this key on GitHub: repository › Settings › Deploy keys › Add deploy key (leave 'Allow write access' OFF):"; echo
  cat /etc/aquatrack/deploy_key.pub; echo
  read -r -p "Press Enter when it is added (Ctrl+C to stop)… " _
done
echo "GitHub access OK"

step "Services"
install -m 0644 "$(dirname "$0")/aquatrack.service" /etc/systemd/system/
install -m 0644 "$(dirname "$0")/aquatrack-update.service" /etc/systemd/system/
install -m 0644 "$(dirname "$0")/aquatrack-update.timer" /etc/systemd/system/
install -m 0755 "$(dirname "$0")/update.sh" /opt/aquatrack/bin/aquatrack-update
ln -sfn /opt/aquatrack/bin/aquatrack-update /usr/local/bin/aquatrack-update
systemctl daemon-reload
systemctl enable aquatrack >/dev/null

step "First release (runs the automated tests first; takes about a minute)"
/opt/aquatrack/bin/aquatrack-update --force
systemctl enable --now aquatrack-update.timer >/dev/null
if [ "$APPMODE" = demo ] && [ ! -f /var/lib/aquatrack/demo/aquatrack-demo.db ]; then
  step "Demo data (fictional)"
  ( cd /opt/aquatrack/current && runuser -u aquatrack -- env -i PATH=/usr/bin:/bin APP_MODE=demo DATA_DIR=/var/lib/aquatrack node --no-warnings=ExperimentalWarning server/seed.js --reset | tail -3 )
  systemctl restart aquatrack
  echo "WARNING: demo accounts use a published password — protect a demo site with Cloudflare Access or keep it private."
fi

if [ -n "$TOKEN" ]; then
  step "Cloudflare Tunnel"
  cloudflared service install "$TOKEN" && echo "Tunnel connector installed."
fi

cat <<EOF

==> AquaTrack is running on this server (http://127.0.0.1:8080, not reachable from outside).

Next:
  1. Create the first administrator:
       cd /opt/aquatrack/current && sudo runuser -u aquatrack -- env APP_MODE=$APPMODE DATA_DIR=/var/lib/aquatrack node --no-warnings=ExperimentalWarning scripts/create-admin.js admin "Your Name"
  2. Cloudflare (if you did not pass --tunnel-token): dashboard › Networking › Tunnels › Create a tunnel › Linux,
     run the "sudo cloudflared service install …" command it shows, then Routes › Add route › Published application:
     hostname e.g. ya.ciu.edu.lr, service http://127.0.0.1:8080
  3. Open https://ya.ciu.edu.lr and sign in.
  Updates: every push to '$BRANCH' on GitHub is tested and installed within ~10 minutes (log: journalctl -t aquatrack-update).
  Back up /etc/aquatrack/aquatrack.env and /var/lib/aquatrack/$APPMODE/backups somewhere off this machine.
EOF
