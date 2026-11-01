#!/usr/bin/env bash
# AquaTrack updater — installed as /opt/aquatrack/bin/aquatrack-update and run by aquatrack-update.timer.
#
#   aquatrack-update               install the latest commit of $BRANCH from $REPO_URL, if it is new
#   aquatrack-update --force       reinstall the latest commit even if it is already running
#   aquatrack-update --zip FILE    install from a release zip instead of GitHub
#   aquatrack-update --rollback    go back to the previous release
#
# Every update: download → run the automated tests on the new code → back up the database → switch →
# restart → health check. If the tests fail nothing changes; if the new version does not come up healthy,
# the previous release is put back automatically.
set -euo pipefail

ENV_FILE=/etc/aquatrack/aquatrack.env
BASE=/opt/aquatrack
REL="$BASE/releases"
KEEP=5
LOG_TAG=aquatrack-update
log() { echo "[$(date -u +%FT%TZ)] $*"; logger -t "$LOG_TAG" -- "$*" 2>/dev/null || true; }
die() { log "ERROR: $*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo)"
[ -f "$ENV_FILE" ] || die "$ENV_FILE not found — run deploy/install.sh first"
set -a; . "$ENV_FILE"; set +a
PORT="${PORT:-8080}"; BRANCH="${BRANCH:-main}"
NODE=$(command -v node) || die "node is not installed"; NPATH="$(dirname "$NODE"):/usr/bin:/bin"
export GIT_SSH_COMMAND="ssh -i /etc/aquatrack/deploy_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/etc/aquatrack/known_hosts"

exec 9>/run/aquatrack-update.lock
flock -n 9 || { log "another update is running"; exit 0; }

MODE=git; ZIP=""; FORCE=0
case "${1:-}" in
  --force) FORCE=1 ;;
  --zip) MODE=zip; ZIP="${2:?give the zip file}" ;;
  --rollback) MODE=rollback ;;
  "") ;;
  *) die "unknown option $1" ;;
esac

current_dir() { readlink -f "$BASE/current" 2>/dev/null || true; }
switch_to() { ln -sfn "$1" "$BASE/current.new" && mv -T "$BASE/current.new" "$BASE/current"; }
healthy() {
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q '"ok":true'; then return 0; fi
    sleep 1
  done
  return 1
}

if [ "$MODE" = rollback ]; then
  CUR=$(current_dir); PREV=$(ls -1d "$REL"/*/ 2>/dev/null | sed 's:/$::' | grep -vx "$CUR" | sort | tail -1 || true)
  [ -n "$PREV" ] || die "no previous release to go back to"
  log "rolling back to $(basename "$PREV")"; switch_to "$PREV"; systemctl restart aquatrack 9>&-
  # keep the timer from reinstalling the version just rolled back from: wait for a newer commit
  if [ -n "${REPO_URL:-}" ]; then R=$(git ls-remote "$REPO_URL" "refs/heads/${BRANCH:-main}" 2>/dev/null | cut -f1); [ -n "$R" ] && touch "$REL/.failed-$R" && log "automatic updates paused until a newer commit than ${R:0:7} is pushed"; fi
  healthy && { log "rollback done"; exit 0; } || die "previous release is not healthy either — check: journalctl -u aquatrack"
fi

NEW_SHA=""
if [ "$MODE" = git ]; then
  [ -n "${REPO_URL:-}" ] || die "REPO_URL is not set in $ENV_FILE"
  NEW_SHA=$(git ls-remote "$REPO_URL" "refs/heads/$BRANCH" | cut -f1)
  [ -n "$NEW_SHA" ] || die "could not read branch $BRANCH from $REPO_URL (deploy key added on GitHub?)"
  CUR_SHA=$(cat "$BASE/current/.release-sha" 2>/dev/null || true)
  if [ "$NEW_SHA" = "$CUR_SHA" ] && [ "$FORCE" -eq 0 ]; then exit 0; fi
  if [ -f "$REL/.failed-$NEW_SHA" ] && [ "$FORCE" -eq 0 ]; then exit 0; fi # this commit already failed its tests; wait for a new one
  log "new version ${NEW_SHA:0:7} on $BRANCH"
fi

STAMP=$(date -u +%Y%m%d-%H%M%S)
DIR="$REL/$STAMP-${NEW_SHA:0:7}"; [ "$MODE" = zip ] && DIR="$REL/$STAMP-zip"
mkdir -p "$DIR"
if [ "$MODE" = git ]; then
  git clone --quiet --depth 1 --branch "$BRANCH" "$REPO_URL" "$DIR"
  rm -rf "$DIR/.git"
else
  TMP=$(mktemp -d); unzip -q "$ZIP" -d "$TMP"
  SRC=$(dirname "$(find "$TMP" -maxdepth 3 -name package.json -print -quit)"); [ -d "$SRC/server" ] || die "zip does not contain AquaTrack"
  cp -a "$SRC/." "$DIR/"; rm -rf "$TMP" "$DIR/data"
  NEW_SHA="zip-$(sha256sum "$ZIP" | cut -c1-12)"
fi
echo "$NEW_SHA" > "$DIR/.release-sha"
chown -R root:aquatrack "$DIR"; chmod -R g+rX,o-rwx "$DIR"

log "testing ${NEW_SHA:0:12} (throwaway demo database, does not touch live data)"
if ! runuser -u aquatrack -- env -i PATH="$NPATH" HOME=/tmp TMPDIR=/tmp "$NODE" --no-warnings=ExperimentalWarning "$DIR/scripts/test-flows.js" > "$DIR/test-output.txt" 2>&1; then
  tail -5 "$DIR/test-output.txt" | while read -r l; do log "  $l"; done
  touch "$REL/.failed-${NEW_SHA}"; rm -rf "$DIR"
  die "tests failed — the running version was NOT changed"
fi
log "tests passed: $(tail -1 "$DIR/test-output.txt")"

log "backing up the database"
( cd "$BASE/current" 2>/dev/null && runuser -u aquatrack -- env -i PATH="$NPATH" APP_MODE="${APP_MODE:-live}" DATA_DIR="$DATA_DIR" "$NODE" --no-warnings=ExperimentalWarning scripts/backup-now.js "pre-update-${NEW_SHA:0:7}" ) \
  || log "no running release to back up from (first install?)"

PREV=$(current_dir)
switch_to "$DIR"
systemctl restart aquatrack 9>&-
if healthy; then
  log "now running ${NEW_SHA:0:12}"
  install -m 0755 "$DIR/deploy/update.sh" "$BASE/bin/aquatrack-update" # the updater updates itself
  ls -1d "$REL"/*/ | sed 's:/$::' | sort | head -n -"$KEEP" | while read -r old; do [ "$old" = "$DIR" ] || rm -rf "$old"; done
  rm -f "$REL"/.failed-*
else
  log "new version did not become healthy — rolling back"
  journalctl -u aquatrack -n 20 --no-pager 2>/dev/null | while read -r l; do log "  $l"; done
  if [ -n "$PREV" ] && [ -d "$PREV" ]; then switch_to "$PREV"; systemctl restart aquatrack 9>&-; healthy && log "previous version restored" || log "previous version is not healthy either"; fi
  touch "$REL/.failed-${NEW_SHA}"
  die "update failed"
fi
