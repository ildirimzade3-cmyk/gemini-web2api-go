#!/usr/bin/env bash
# Host orchestration of the bridge's self-repair, run by gemini-web-repair.service
# (timer-driven; safe to run by hand). One run looks at the bridge's canary and, if
# needed, takes the next step of the ladder:
#
#   canary ok              -> stop the browser transport if it is running
#   canary failing         -> (at most every COOLDOWN_S) run the `learn` container, then
#                             watch /healthz for up to RECHECK_WAIT_S for the bridge's own
#                             re-check; recovered -> done
#   still failing          -> start the browser transport container (gemini-web-browser)
#
# Every decision is also written to the bridge's event log (POST /admin/api/events).
#
# Environment (from /etc/miraz/gemini-web-repair.env via the unit):
#   BRIDGE_URL            bridge base URL as seen from the host, e.g. http://127.0.0.1:18083   (required)
#   BRIDGE_ADMIN_TOKEN    admin bearer token                                                   (required)
#   GEMINI_WEB_COMMIT     image tag; docker compose interpolates it for the whole file         (required by the compose file)
#   COMPOSE_FILE          default /opt/miraz/deploy/vps/gemini-web/docker-compose.yml
#   REPAIR_SERVICE        compose service of the learn job (profile "repair"), default gemini-web-repair
#   BROWSER_SERVICE       compose service of the browser transport (profile "browser"), default gemini-web-browser
#   COOLDOWN_S            minimum seconds between learn runs (default 1800)
#   RECHECK_WAIT_S        how long to wait for the bridge's re-check after a learn run (default 180)
#   RECHECK_POLL_S        /healthz poll interval while waiting (default 10)
#   STATE_DIR             last-run stamp and lock (default /var/lib/gemini-web-repair)
#   PYTHON                interpreter for the small JSON helpers (default python3)
#
# Exit status: 0 normally; 1 when the browser transport could not be started.
set -euo pipefail

: "${BRIDGE_URL:?BRIDGE_URL is required}"
: "${BRIDGE_ADMIN_TOKEN:?BRIDGE_ADMIN_TOKEN is required}"
COMPOSE_FILE="${COMPOSE_FILE:-/opt/miraz/deploy/vps/gemini-web/docker-compose.yml}"
REPAIR_SERVICE="${REPAIR_SERVICE:-gemini-web-repair}"
BROWSER_SERVICE="${BROWSER_SERVICE:-gemini-web-browser}"
COOLDOWN_S="${COOLDOWN_S:-1800}"
RECHECK_WAIT_S="${RECHECK_WAIT_S:-180}"
RECHECK_POLL_S="${RECHECK_POLL_S:-10}"
STATE_DIR="${STATE_DIR:-/var/lib/gemini-web-repair}"
PYTHON="${PYTHON:-python3}"
BASE="${BRIDGE_URL%/}"
STAMP="$STATE_DIR/last-run"

log() { echo "gemini-web-repair: $*" >&2; }
compose() { docker compose -f "$COMPOSE_FILE" "$@"; }

# Sets CANARY_OK (true|false|none), CANARY_AT (unix seconds, 0 when unknown) and
# CANARY_CLASS (error class, "-" when none). Returns 1 when /healthz is unreachable.
read_canary() {
  local body
  body="$(curl -fsS --max-time 10 "$BASE/healthz")" || return 1
  read -r CANARY_OK CANARY_AT CANARY_CLASS < <("$PYTHON" -c '
import json, re, sys
from datetime import datetime
try:
    c = (json.load(sys.stdin) or {}).get("last_canary")
except Exception:
    c = None
if not isinstance(c, dict) or not isinstance(c.get("ok"), bool):
    print("none 0 -")
    sys.exit(0)
at = c.get("at")
secs = 0
if isinstance(at, (int, float)) and not isinstance(at, bool):
    secs = int(at / 1000 if at > 1e11 else at)
elif isinstance(at, str):
    try:
        secs = int(datetime.fromisoformat(at.replace("Z", "+00:00")).timestamp())
    except ValueError:
        pass
cls = re.sub(r"[^A-Za-z0-9_.-]", "", str(c.get("error_class") or "")) or "-"
print("true" if c["ok"] else "false", secs, cls)
' <<<"$body")
  CANARY_CLASS="$(printf %s "$CANARY_CLASS" | tr -d '\r')" # python on Windows ends lines with CRLF
}

# Best effort: a failed event post never stops the ladder. The token goes through a
# curl config on a pipe, not the command line.
post_event() {
  "$PYTHON" -c 'import json, sys; print(json.dumps({"kind": sys.argv[1], "detail": sys.argv[2][:500]}))' "$1" "$2" |
    curl -sS --max-time 10 -o /dev/null -X POST -K <(printf 'header = "Authorization: Bearer %s"\n' "$BRIDGE_ADMIN_TOKEN") \
      -H 'content-type: application/json' --data-binary @- "$BASE/admin/api/events" || true
}

browser_running() {
  [[ -n "$(compose --profile browser ps --status running -q "$BROWSER_SERVICE" 2>/dev/null || true)" ]]
}

stop_browser() {
  log "canary ok again, stopping $BROWSER_SERVICE"
  if compose --profile browser stop "$BROWSER_SERVICE" >&2; then
    post_event browser_fallback_stopped "canary ok again; $BROWSER_SERVICE stopped"
  else
    post_event browser_fallback_failed "could not stop $BROWSER_SERVICE"
  fi
}

start_browser() {
  log "canary still failing, starting $BROWSER_SERVICE"
  if compose --profile browser up -d "$BROWSER_SERVICE" >&2; then
    post_event browser_fallback_started "canary still failing (class=$CANARY_CLASS); $BROWSER_SERVICE started"
  else
    post_event browser_fallback_failed "docker compose up $BROWSER_SERVICE failed"
    return 1
  fi
}

# After a learn run: wait for the bridge's own canary re-check. Returns 0 when the
# canary is ok again; 1 when the bridge re-checked and it still fails, or time ran out.
wait_for_recheck() {
  local finished deadline
  finished="$(date +%s)"
  deadline=$(( finished + RECHECK_WAIT_S ))
  while :; do
    if read_canary; then
      [[ $CANARY_OK == true ]] && return 0
      # A failure newer than the end of the learn run is the bridge's verdict after the repair.
      if [[ $CANARY_OK == false ]] && (( CANARY_AT >= finished )); then return 1; fi
    fi
    (( $(date +%s) >= deadline )) && return 1
    sleep "$RECHECK_POLL_S"
  done
}

mkdir -p "$STATE_DIR"
exec 9>"$STATE_DIR/lock"
flock -n 9 || { log "another run holds the lock, skipping"; exit 0; }

# A bridge that does not answer is not a protocol problem; leave it to other monitoring.
if ! read_canary; then
  log "healthz unreachable, doing nothing"
  exit 0
fi

if [[ $CANARY_OK == true ]]; then
  browser_running && stop_browser
  exit 0
fi
[[ $CANARY_OK == false ]] || exit 0 # no canary result yet
# A quota limit or a dead account is not a protocol change: neither the learn job
# nor the browser transport (same account) can help, so nothing starts.
case "$CANARY_CLASS" in
  upstream_rate_limited|no_valid_account)
    log "canary failing with $CANARY_CLASS, not a protocol problem; doing nothing"
    exit 0 ;;
esac

now="$(date +%s)"
last="$(cat "$STAMP" 2>/dev/null || echo 0)"
if (( now - last >= COOLDOWN_S )); then
  echo "$now" >"$STAMP" # stamp before the run so a failing repair is throttled too
  log "canary failing (class=$CANARY_CLASS), running learn"
  post_event repair_trigger "canary failing (class=$CANARY_CLASS); running learn"
  rc=0
  compose --profile repair run --rm -T "$REPAIR_SERVICE" learn >&2 || rc=$?
  log "learn exited with $rc"
  if wait_for_recheck; then
    log "canary ok after learn"
    post_event repair_recovered "canary ok after learn (exit $rc)"
    browser_running && stop_browser
    exit 0
  fi
  post_event repair_not_recovered "canary still failing after learn (exit $rc, class=$CANARY_CLASS)"
else
  log "canary failing, last learn $(( now - last ))s ago (cooldown ${COOLDOWN_S}s)"
fi

browser_running || start_browser
