#!/usr/bin/env bash
# Starts the self-repair container only when the bridge's canary is failing and
# no repair ran in the last COOLDOWN_S seconds. Meant to be run by
# gemini-web-repair.service (timer-driven); safe to run by hand.
#
# Environment (from /etc/gemini-web-repair.env via the unit):
#   BRIDGE_URL            e.g. http://gemini-web.internal:8083      (required)
#   BRIDGE_ADMIN_TOKEN    admin bearer token                         (required)
#   REPAIR_IMAGE          image to run (default gemini-web-repair:1)
#   REPAIR_DOCKER_NETWORK docker network that resolves BRIDGE_URL    (optional)
#   GEMINI_REPAIR_API_KEY / GEMINI_REPAIR_MODEL                      (optional, AI fallback)
#   COOLDOWN_S            minimum seconds between repair runs (default 1800)
#   STATE_DIR             where the last-run stamp lives (default /var/lib/gemini-web-repair)
#
# Exit status: 0 nothing to do or repair adopted, otherwise the container's exit
# code (1 failed, 2 learned but not validated; the unit treats 2 as success).
set -euo pipefail

: "${BRIDGE_URL:?BRIDGE_URL is required}"
: "${BRIDGE_ADMIN_TOKEN:?BRIDGE_ADMIN_TOKEN is required}"
IMAGE="${REPAIR_IMAGE:-gemini-web-repair:1}"
COOLDOWN_S="${COOLDOWN_S:-1800}"
STATE_DIR="${STATE_DIR:-/var/lib/gemini-web-repair}"
STAMP="$STATE_DIR/last-run"

log() { echo "gemini-web-repair: $*" >&2; }

mkdir -p "$STATE_DIR"
exec 9>"$STATE_DIR/lock"
flock -n 9 || { log "another run holds the lock, skipping"; exit 0; }

# A bridge that does not answer is not a protocol problem; leave it to other monitoring.
if ! health="$(curl -fsS --max-time 10 "${BRIDGE_URL%/}/healthz")"; then
  log "healthz unreachable, not repairing"
  exit 0
fi
if ! jq -e '.last_canary.ok == false' >/dev/null <<<"$health"; then
  exit 0 # canary ok, absent or not yet run
fi

now="$(date +%s)"
last="$(cat "$STAMP" 2>/dev/null || echo 0)"
if (( now - last < COOLDOWN_S )); then
  log "canary failing, but a repair ran $(( now - last ))s ago (cooldown ${COOLDOWN_S}s)"
  exit 0
fi
echo "$now" >"$STAMP" # stamp before the run so a failing repair is throttled too

log "canary failing, starting repair container $IMAGE"
args=(run --rm --init --name gemini-web-repair
  --memory 1g --memory-swap 1g --cpus 1 --pids-limit 512
  --cap-drop ALL --security-opt no-new-privileges
  --read-only --tmpfs /tmp --tmpfs /home/pwuser
  -e BRIDGE_URL -e BRIDGE_ADMIN_TOKEN)
[[ -n "${REPAIR_DOCKER_NETWORK:-}" ]] && args+=(--network "$REPAIR_DOCKER_NETWORK")
[[ -n "${GEMINI_REPAIR_API_KEY:-}" ]] && args+=(-e GEMINI_REPAIR_API_KEY)
[[ -n "${GEMINI_REPAIR_MODEL:-}" ]] && args+=(-e GEMINI_REPAIR_MODEL)

rc=0
docker "${args[@]}" "$IMAGE" || rc=$?
log "repair container exited with $rc"
exit "$rc"
