package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// isolateHealthState gives a test a clean canary record, event log and account
// table, and restores a clean state afterwards.
func isolateHealthState(t *testing.T) {
	t.Helper()
	reset := func() {
		_ = kvSet(canaryKVKey, "")
		_, _ = getDB().Exec(`DELETE FROM events`)
		_, _ = getDB().Exec(`DELETE FROM accounts`)
	}
	reset()
	t.Cleanup(reset)
}

func stubCanary(t *testing.T, fn func(ctx context.Context) (string, *StreamResult, error)) {
	t.Helper()
	old := canaryGenerate
	canaryGenerate = fn
	t.Cleanup(func() { canaryGenerate = old })
}

func getHealth(t *testing.T) (int, map[string]interface{}) {
	t.Helper()
	rec := httptest.NewRecorder()
	handleHealthz(rec, httptest.NewRequest("GET", "/healthz", nil))
	var m map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("healthz is not JSON: %v (%s)", err, rec.Body.String())
	}
	return rec.Code, m
}

func TestHealthzAccountRules(t *testing.T) {
	withRuntime(t, nil)
	isolateHealthState(t)

	// No accounts at all: the deployment runs anonymously by design.
	code, h := getHealth(t)
	if code != 200 || h["status"] != "ok" {
		t.Fatalf("anonymous deployment: %d %v", code, h)
	}

	// One healthy account.
	id, err := accountAdd("health-test", "SAPISID=dummy; SID=x", "")
	if err != nil {
		t.Fatal(err)
	}
	code, h = getHealth(t)
	acc := h["accounts"].(map[string]interface{})
	if code != 200 || acc["total"] != 1.0 || acc["enabled"] != 1.0 || acc["healthy"] != 1.0 {
		t.Fatalf("one healthy account: %d %v", code, h)
	}

	// Enabled but failing: not healthy, and anonymous fallback is off -> 503.
	if _, err := getDB().Exec(`UPDATE accounts SET fail_count=2 WHERE id=?`, id); err != nil {
		t.Fatal(err)
	}
	code, h = getHealth(t)
	acc = h["accounts"].(map[string]interface{})
	if code != 503 || acc["enabled"] != 1.0 || acc["healthy"] != 0.0 || h["status"] != "unhealthy" {
		t.Fatalf("failing account: %d %v", code, h)
	}
	// ... unless anonymous fallback is enabled.
	withRuntime(t, func(c *RuntimeConfig) { c.FallbackAnon = true })
	if code, _ = getHealth(t); code != 200 {
		t.Errorf("fallback_anon should keep the service healthy, got %d", code)
	}
	withRuntime(t, nil)

	// Only a disabled account.
	if err := accountSetStatus(id, "disabled"); err != nil {
		t.Fatal(err)
	}
	code, h = getHealth(t)
	acc = h["accounts"].(map[string]interface{})
	if code != 503 || acc["total"] != 1.0 || acc["enabled"] != 0.0 {
		t.Fatalf("only a disabled account: %d %v", code, h)
	}
}

func TestHealthzShapeAndSecrets(t *testing.T) {
	withRuntime(t, nil)
	isolateHealthState(t)
	resetBLState(t)
	if _, err := accountAdd("secret-label@example.com", "SAPISID=SUPERSECRETVALUE; SID=x", ""); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	handleHealthz(rec, httptest.NewRequest("GET", "/healthz", nil))
	body := rec.Body.String()
	for _, secret := range []string{"SUPERSECRETVALUE", "secret-label", "example.com", "SAPISID"} {
		if strings.Contains(body, secret) {
			t.Errorf("healthz leaks %q: %s", secret, body)
		}
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"status", "version", "accounts", "bl", "xsrf_ok_last", "last_canary"} {
		if _, ok := m[k]; !ok {
			t.Errorf("healthz lacks %q: %s", k, body)
		}
	}
	var bl struct {
		ValueAgeSeconds *int64 `json:"value_age_seconds"`
		Source          string `json:"source"`
	}
	if err := json.Unmarshal(m["bl"], &bl); err != nil || (bl.Source != "auto" && bl.Source != "config") {
		t.Errorf("bl block: %s", m["bl"])
	}

	// The route is public: no key, no admin session.
	if rec.Code != 200 {
		t.Errorf("status %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	handleHealthz(rec, httptest.NewRequest("POST", "/healthz", nil))
	if rec.Code != 405 {
		t.Errorf("POST /healthz: %d, want 405", rec.Code)
	}
}

func TestHealthzReflectsCanaryAndRecovery(t *testing.T) {
	withRuntime(t, nil)
	isolateHealthState(t)
	if _, err := accountAdd("canary-test", "SAPISID=dummy; SID=x", ""); err != nil {
		t.Fatal(err)
	}

	// 1) failing canary -> 503, with the class in the report and one event.
	stubCanary(t, func(ctx context.Context) (string, *StreamResult, error) {
		return "", nil, newUpstreamError(ClassRateLimited, 429, "upstream HTTP 429: x")
	})
	res, started := runCanary(context.Background())
	if !started || res.OK || res.ErrorClass != "upstream_rate_limited" {
		t.Fatalf("failing canary: started=%v %+v", started, res)
	}
	code, h := getHealth(t)
	lc := h["last_canary"].(map[string]interface{})
	if code != 503 || lc["ok"] != false || lc["error_class"] != "upstream_rate_limited" {
		t.Fatalf("after failed canary: %d %v", code, h)
	}

	// 2) same failure again: still failing, no duplicate event.
	runCanary(context.Background())
	if n := countEvents(EventCanaryFailed); n != 1 {
		t.Errorf("canary_failed events = %d, want 1 (state change only)", n)
	}

	// 3) success -> healthy again, a recovery event.
	stubCanary(t, func(ctx context.Context) (string, *StreamResult, error) { return "Pong.", nil, nil })
	res, _ = runCanary(context.Background())
	if !res.OK || res.ErrorClass != "" || res.At == 0 {
		t.Fatalf("recovered canary: %+v", res)
	}
	code, h = getHealth(t)
	if code != 200 || h["last_canary"].(map[string]interface{})["ok"] != true {
		t.Fatalf("after recovery: %d %v", code, h)
	}
	if countEvents(EventCanaryRecovered) != 1 {
		t.Errorf("no canary_recovered event; events: %v", eventKinds())
	}

	// 4) an answer that is not "pong" is a failure of its own kind.
	stubCanary(t, func(ctx context.Context) (string, *StreamResult, error) { return "banana", nil, nil })
	res, _ = runCanary(context.Background())
	if res.OK || res.ErrorClass != canaryWrongAnswer {
		t.Errorf("wrong answer: %+v", res)
	}
	if code, _ = getHealth(t); code != 503 {
		t.Errorf("wrong canary answer should fail health, got %d", code)
	}
}

// A full local limiter says nothing about Google: such a run is not recorded.
func TestCanarySkippedWhenLocalLimiterFull(t *testing.T) {
	withRuntime(t, nil)
	isolateHealthState(t)
	stubCanary(t, func(ctx context.Context) (string, *StreamResult, error) {
		return "", nil, &RateLimitError{Reason: "rpm"}
	})
	res, started := runCanary(context.Background())
	if !started || !res.Skipped || res.ErrorClass != "ip_slot_full" {
		t.Fatalf("%+v", res)
	}
	if loadLastCanary() != nil {
		t.Error("a skipped run must not be persisted")
	}
	if code, _ := getHealth(t); code != 200 {
		t.Errorf("health = %d, want 200", code)
	}
}

func countEvents(kind string) int {
	n := 0
	for _, k := range eventKinds() {
		if k == kind {
			n++
		}
	}
	return n
}

func TestMaybeRunCanarySchedule(t *testing.T) {
	isolateHealthState(t)
	var calls atomic.Int32
	stubCanary(t, func(ctx context.Context) (string, *StreamResult, error) {
		calls.Add(1)
		return "pong", nil, nil
	})

	withRuntime(t, func(c *RuntimeConfig) { c.CanaryIntervalMin = 0 })
	maybeRunCanary()
	if calls.Load() != 0 {
		t.Fatal("interval 0 disables the scheduled canary")
	}

	withRuntime(t, func(c *RuntimeConfig) { c.CanaryIntervalMin = 30 })
	maybeRunCanary() // never ran: due
	if calls.Load() != 1 {
		t.Fatalf("first run due, calls=%d", calls.Load())
	}
	maybeRunCanary() // just ran: not due
	if calls.Load() != 1 {
		t.Fatalf("second tick must not run, calls=%d", calls.Load())
	}
	old := CanaryResult{OK: true, At: time.Now().Add(-31 * time.Minute).Unix()}
	saveCanary(old)
	maybeRunCanary() // 31 min old: due again
	if calls.Load() != 2 {
		t.Fatalf("stale canary should re-run, calls=%d", calls.Load())
	}
}

func TestAdminCanaryEndpoint(t *testing.T) {
	withRuntime(t, nil)
	isolateHealthState(t)
	stubCanary(t, func(ctx context.Context) (string, *StreamResult, error) { return "pong", nil, nil })

	rec := httptest.NewRecorder()
	handleAdminCanary(rec, httptest.NewRequest("POST", "/admin/api/canary", nil))
	var res CanaryResult
	if rec.Code != 200 || json.Unmarshal(rec.Body.Bytes(), &res) != nil || !res.OK {
		t.Fatalf("on-demand canary: %d %s", rec.Code, rec.Body.String())
	}
	if last := loadLastCanary(); last == nil || !last.OK {
		t.Error("on-demand result must be recorded for /healthz")
	}

	rec = httptest.NewRecorder()
	handleAdminCanary(rec, httptest.NewRequest("GET", "/admin/api/canary", nil))
	if rec.Code != 405 {
		t.Errorf("GET: %d, want 405", rec.Code)
	}

	// A canary already in flight is not started twice.
	canaryMu.Lock()
	rec = httptest.NewRecorder()
	handleAdminCanary(rec, httptest.NewRequest("POST", "/admin/api/canary", nil))
	canaryMu.Unlock()
	if rec.Code != 409 {
		t.Errorf("concurrent canary: %d, want 409", rec.Code)
	}
}

func TestCanaryErrorClass(t *testing.T) {
	for _, c := range []struct {
		err  error
		want string
	}{
		{newUpstreamError(ClassNoAccount, 0, "x"), "no_valid_account"},
		{fmt.Errorf("w: %w", newUpstreamError(ClassProtocolChanged, 0, "x")), "upstream_protocol_changed"},
		{&RateLimitError{Reason: "rph"}, "ip_slot_full"},
		{context.Canceled, "canceled"},
		{errors.New("odd"), "upstream_unavailable"},
	} {
		if got := canaryErrorClass(c.err); got != c.want {
			t.Errorf("canaryErrorClass(%v) = %q, want %q", c.err, got, c.want)
		}
	}
}

func TestEventsLogAndAPI(t *testing.T) {
	isolateHealthState(t)
	LogEvent("kind_a", "first")
	LogEvent("kind_b", "second")
	LogEvent("kind_c", strings.Repeat("x", 2000))

	evs := listEvents(10)
	if len(evs) != 3 || evs[0].Kind != "kind_c" || evs[2].Kind != "kind_a" {
		t.Fatalf("newest first expected, got %+v", evs)
	}
	if len(evs[0].Detail) != eventDetailMax {
		t.Errorf("detail length %d, want %d", len(evs[0].Detail), eventDetailMax)
	}
	if evs[0].TS == 0 || evs[0].ID == 0 {
		t.Errorf("missing ts/id: %+v", evs[0])
	}

	// The API lists at most the latest 200.
	for i := 0; i < 205; i++ {
		LogEvent("bulk", fmt.Sprintf("n=%d", i))
	}
	rec := httptest.NewRecorder()
	handleAdminEvents(rec, httptest.NewRequest("GET", "/admin/api/events", nil))
	var body struct {
		Events []EventRow `json:"events"`
	}
	if rec.Code != 200 || json.Unmarshal(rec.Body.Bytes(), &body) != nil {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	if len(body.Events) != 200 || body.Events[0].Detail != "n=204" {
		t.Errorf("got %d events, first %+v", len(body.Events), body.Events[0])
	}
	rec = httptest.NewRecorder()
	handleAdminEvents(rec, httptest.NewRequest("POST", "/admin/api/events", nil))
	if rec.Code != 405 {
		t.Errorf("POST: %d", rec.Code)
	}

	// Throttled kinds are written once per window.
	_, _ = getDB().Exec(`DELETE FROM events`)
	eventThrottleMu.Lock()
	eventThrottleLast = map[string]time.Time{}
	eventThrottleMu.Unlock()
	for i := 0; i < 5; i++ {
		logEventThrottled("flappy", "x", time.Hour)
	}
	if n := countEvents("flappy"); n != 1 {
		t.Errorf("throttled event written %d times, want 1", n)
	}
}

// The auto-disable of a dead account is written to the event log, by id only.
func TestAccountAutoDisableIsLogged(t *testing.T) {
	isolateHealthState(t)
	id, err := accountAdd("someone@example.com", "SAPISID=dummy; SID=x", "")
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < maxCookieAuthFailures; i++ {
		markCookieByStatus(id, 401, "auth failed")
	}
	if a := accountByID(id); a == nil || a.Status != "disabled" {
		t.Fatalf("account not disabled: %+v", a)
	}
	var found *EventRow
	for _, e := range listEvents(10) {
		if e.Kind == EventAccountDisabled {
			e := e
			found = &e
		}
	}
	if found == nil {
		t.Fatalf("no account_disabled event; events: %v", eventKinds())
	}
	if !strings.Contains(found.Detail, fmt.Sprintf("#%d", id)) || strings.Contains(found.Detail, "example.com") {
		t.Errorf("event detail should name the account by id only: %q", found.Detail)
	}
}

func TestRuntimeConfigCanaryInterval(t *testing.T) {
	withRuntime(t, nil)
	ok := rtCfg()
	ok.RetentionDays = 30
	ok.CanaryIntervalMin = 0
	if err := validateRuntimeConfig(ok); err != nil {
		t.Errorf("0 (disabled) must be valid: %v", err)
	}
	ok.CanaryIntervalMin = 30
	if err := validateRuntimeConfig(ok); err != nil {
		t.Errorf("30 must be valid: %v", err)
	}
	ok.CanaryIntervalMin = -1
	if validateRuntimeConfig(ok) == nil {
		t.Error("negative interval must be rejected")
	}
	ok.CanaryIntervalMin = 1441
	if validateRuntimeConfig(ok) == nil {
		t.Error("interval above a day must be rejected")
	}
	if defaultConfig().CanaryIntervalMin != 30 {
		t.Errorf("default canary interval = %d, want 30", defaultConfig().CanaryIntervalMin)
	}
}

// The server must never cut a long answer: WriteTimeout stays 0, and bodies are capped.
func TestServerTimeoutsAndBodyCap(t *testing.T) {
	srv := newHTTPServer(":0", http.NotFoundHandler())
	if srv.WriteTimeout != 0 {
		t.Errorf("WriteTimeout = %s: a long answer would be cut", srv.WriteTimeout)
	}
	if srv.ReadTimeout != 30*time.Second {
		t.Errorf("ReadTimeout = %s", srv.ReadTimeout)
	}

	old := maxRequestBodyBytes
	maxRequestBodyBytes = 16
	t.Cleanup(func() { maxRequestBodyBytes = old })
	srv = newHTTPServer(":0", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := io.ReadAll(r.Body); err != nil {
			writeBodyReadError(w, err)
		}
	}))
	rec := httptest.NewRecorder()
	srv.Handler.ServeHTTP(rec, httptest.NewRequest("POST", "/v1/responses", strings.NewReader(strings.Repeat("x", 100))))
	if rec.Code != 413 {
		t.Errorf("server handler did not cap the body: %d", rec.Code)
	}
}
