package app

import (
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"sync"
	"time"
	"unicode/utf8"
)

// Structured event log: a small table of things an operator wants to see after
// the fact (canary failure/recovery, bl change, account auto-disabled, Google
// protocol-parse failures). It is not a request log and never holds prompts,
// answers or cookies.

// Event kinds.
const (
	EventCanaryFailed      = "canary_failed"
	EventCanaryRecovered   = "canary_recovered"
	EventBLChanged         = "bl_changed"
	EventAccountDisabled   = "account_disabled"
	EventProtocolParseFail = "protocol_parse_failure"
	// Self-repair (repair.go) and the browser transport (browser_fallback.go).
	EventRepairContextServed = "repair_context_served"
	EventRepairAdopted       = "repair_adopted"
	EventRepairUnvalidated   = "repair_unvalidated"
	EventBrowserFallback     = "browser_fallback_used"
)

const (
	eventDetailMax = 500
	eventListLimit = 200
)

// EventRow is one row of the events table.
type EventRow struct {
	ID     int64  `json:"id"`
	TS     int64  `json:"ts"`
	Kind   string `json:"kind"`
	Detail string `json:"detail"`
}

// LogEvent records an event. Failures to write are logged and swallowed: the
// event log must never break the path that reports into it.
func LogEvent(kind, detail string) { logEventID(kind, detail) }

// logEventID is LogEvent returning the id of the new row (0 when it failed).
func logEventID(kind, detail string) int64 {
	detail = truncate(detail, eventDetailMax)
	id, err := insertID(`INSERT INTO events(ts, kind, detail) VALUES (?,?,?)`,
		time.Now().Unix(), kind, detail)
	if err != nil {
		logf("[events] insert failed: %v", err)
		return 0
	}
	logf("[event] %s: %s", kind, detail)
	return id
}

var (
	eventThrottleMu   sync.Mutex
	eventThrottleLast = map[string]time.Time{}
)

// logEventThrottled is LogEvent limited to one row per kind per `every`, for
// kinds that can fire on every request (protocol-parse failures).
func logEventThrottled(kind, detail string, every time.Duration) {
	eventThrottleMu.Lock()
	if last, ok := eventThrottleLast[kind]; ok && time.Since(last) < every {
		eventThrottleMu.Unlock()
		return
	}
	eventThrottleLast[kind] = time.Now()
	eventThrottleMu.Unlock()
	LogEvent(kind, detail)
}

// listEvents returns the newest events first.
func listEvents(limit int) []EventRow {
	if limit <= 0 || limit > eventListLimit {
		limit = eventListLimit
	}
	rows, err := getDB().Query(
		`SELECT id, ts, kind, COALESCE(detail,'') FROM events ORDER BY ts DESC, id DESC LIMIT ?`, limit)
	if err != nil {
		return nil
	}
	defer rows.Close()
	out := []EventRow{}
	for rows.Next() {
		var e EventRow
		if rows.Scan(&e.ID, &e.TS, &e.Kind, &e.Detail) == nil {
			out = append(out, e)
		}
	}
	return out
}

// eventKindRe is the shape of a kind an external writer (the repair job) may post.
var eventKindRe = regexp.MustCompile(`^[a-z_]{3,40}$`)

// handleAdminEvents serves GET /admin/api/events (the latest 200 events) and
// POST /admin/api/events {kind, detail}: an external writer such as the repair
// job adds a row (kind ^[a-z_]{3,40}$, detail at most 500 characters).
func handleAdminEvents(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, 200, map[string]interface{}{"events": listEvents(eventListLimit)})
	case http.MethodPost:
		var req struct {
			Kind   string `json:"kind"`
			Detail string `json:"detail"`
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
		if err != nil || json.Unmarshal(body, &req) != nil {
			writeJSON(w, 400, map[string]string{"error": "invalid JSON body"})
			return
		}
		if !eventKindRe.MatchString(req.Kind) {
			writeJSON(w, 400, map[string]string{"error": "kind must match ^[a-z_]{3,40}$"})
			return
		}
		if utf8.RuneCountInString(req.Detail) > eventDetailMax {
			writeJSON(w, 400, map[string]string{"error": "detail is longer than 500 characters"})
			return
		}
		writeJSON(w, 200, map[string]interface{}{"ok": true, "event_id": logEventID(req.Kind, req.Detail)})
	default:
		writeJSON(w, 405, map[string]string{"error": "method not allowed"})
	}
}
