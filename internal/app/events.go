package app

import (
	"net/http"
	"sync"
	"time"
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
func LogEvent(kind, detail string) {
	detail = truncate(detail, eventDetailMax)
	_, err := getDB().Exec(`INSERT INTO events(ts, kind, detail) VALUES (?,?,?)`,
		time.Now().Unix(), kind, detail)
	if err != nil {
		logf("[events] insert failed: %v", err)
		return
	}
	logf("[event] %s: %s", kind, detail)
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

// handleAdminEvents serves GET /admin/api/events (the latest 200 events).
func handleAdminEvents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, 405, map[string]string{"error": "method not allowed"})
		return
	}
	writeJSON(w, 200, map[string]interface{}{"events": listEvents(eventListLimit)})
}
