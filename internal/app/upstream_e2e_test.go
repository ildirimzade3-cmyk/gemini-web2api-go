package app

// End-to-end tests of the generation path against a fake Google served by
// httptest: status mapping, request cancellation, the missing total timeout and
// the stale-bl self-heal. Nothing here touches the network.

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const (
	e2eOldBL = "boq_old-service_20260101.01_p0"
	e2eNewBL = "boq_new-service_20270101.01_p0"
)

// withRuntime installs a runtime config for the test (retries off, no limiter,
// no scheduled work) and restores the previous one afterwards.
func withRuntime(t *testing.T, mut func(*RuntimeConfig)) {
	t.Helper()
	rtMu.Lock()
	old := rtVal
	rtVal = RuntimeConfig{
		RetryAttempts:  1,
		RetryDelaySec:  0,
		RequestTimeout: 30,
		DefaultModel:   "gemini-3.6-flash",
		Impersonate:    "chrome_146",
		GeminiBL:       e2eOldBL,
	}
	if mut != nil {
		mut(&rtVal)
	}
	rtMu.Unlock()
	t.Cleanup(func() { rtMu.Lock(); rtVal = old; rtMu.Unlock() })
}

// resetBLState isolates the package-level bl state and the event log for a test.
func resetBLState(t *testing.T) {
	t.Helper()
	blMu.Lock()
	saved := [4]interface{}{blFetched, blFetchAt, blValueAt, blForcedAt}
	blFetched, blFetchAt, blValueAt, blForcedAt = "", time.Now(), time.Time{}, time.Time{}
	blMu.Unlock()
	eventThrottleMu.Lock()
	eventThrottleLast = map[string]time.Time{}
	eventThrottleMu.Unlock()
	clearEvents(t)
	t.Cleanup(func() {
		blMu.Lock()
		blFetched, blFetchAt = saved[0].(string), saved[1].(time.Time)
		blValueAt, blForcedAt = saved[2].(time.Time), saved[3].(time.Time)
		blMu.Unlock()
		clearEvents(t)
	})
}

func clearEvents(t *testing.T) {
	t.Helper()
	if _, err := getDB().Exec(`DELETE FROM events`); err != nil {
		t.Fatalf("clear events: %v", err)
	}
}

func eventKinds() []string {
	var kinds []string
	for _, e := range listEvents(200) {
		kinds = append(kinds, e.Kind)
	}
	return kinds
}

func hasEvent(kind string) bool {
	for _, k := range eventKinds() {
		if k == kind {
			return true
		}
	}
	return false
}

// fakeGoogle stands in for gemini.google.com.
type fakeGoogle struct {
	srv        *httptest.Server
	streamHits atomic.Int32
	appHits    atomic.Int32
	mu         sync.Mutex
	stream     http.HandlerFunc
	app        http.HandlerFunc
}

func newFakeGoogle(t *testing.T) *fakeGoogle {
	t.Helper()
	f := &fakeGoogle{}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		stream, app := f.stream, f.app
		f.mu.Unlock()
		switch {
		case strings.HasSuffix(r.URL.Path, "/StreamGenerate"):
			f.streamHits.Add(1)
			stream(w, r)
		case r.URL.Path == "/app":
			f.appHits.Add(1)
			if app == nil {
				http.NotFound(w, r)
				return
			}
			app(w, r)
		default:
			http.NotFound(w, r)
		}
	}))
	old := geminiBaseURL
	geminiBaseURL = f.srv.URL
	t.Cleanup(func() { geminiBaseURL = old; f.srv.Close() })
	return f
}

func (f *fakeGoogle) setStream(h http.HandlerFunc) { f.mu.Lock(); f.stream = h; f.mu.Unlock() }
func (f *fakeGoogle) setApp(h http.HandlerFunc)    { f.mu.Lock(); f.app = h; f.mu.Unlock() }

func writeRaw(w http.ResponseWriter, status int, body string) {
	w.WriteHeader(status)
	_, _ = w.Write([]byte(body))
}

func postJSON(t *testing.T, h http.HandlerFunc, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("POST", path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h(rec, req)
	return rec
}

const chatBody = `{"model":"gemini-3.6-flash","messages":[{"role":"user","content":"hi"}]}`

func errorBody(t *testing.T, rec *httptest.ResponseRecorder) (typ, code, msg string) {
	t.Helper()
	var b struct {
		Error struct{ Message, Type, Code string } `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &b); err != nil {
		t.Fatalf("error body is not JSON: %v (%s)", err, rec.Body.String())
	}
	return b.Error.Type, b.Error.Code, b.Error.Message
}

func TestE2EChatStatusMapping(t *testing.T) {
	withRuntime(t, nil)
	resetBLState(t)
	g := newFakeGoogle(t)

	cases := []struct {
		name       string
		handler    http.HandlerFunc
		status     int
		code       string
		retryAfter string
	}{
		{"429 with Retry-After", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Retry-After", "17")
			writeRaw(w, 429, "slow down")
		}, 429, "upstream_rate_limited", "17"},
		{"429 without Retry-After", func(w http.ResponseWriter, r *http.Request) { writeRaw(w, 429, "") },
			429, "upstream_rate_limited", "60"},
		{"302 to sorry", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Location", "https://www.google.com/sorry/index?continue=x")
			writeRaw(w, 302, "")
		}, 429, "upstream_rate_limited", "7200"},
		{"quota text", func(w http.ResponseWriter, r *http.Request) {
			writeRaw(w, 400, `{"error":{"status":"RESOURCE_EXHAUSTED"}}`)
		}, 429, "upstream_rate_limited", "60"},
		{"500", func(w http.ResponseWriter, r *http.Request) { writeRaw(w, 500, "oops") },
			503, "upstream_unavailable", ""},
		{"503", func(w http.ResponseWriter, r *http.Request) { writeRaw(w, 503, "") },
			503, "upstream_unavailable", ""},
		{"200 without content frame", func(w http.ResponseWriter, r *http.Request) { writeRaw(w, 200, rejectedRaw) },
			503, "upstream_unavailable", ""},
		{"200 empty body", func(w http.ResponseWriter, r *http.Request) { writeRaw(w, 200, "") },
			503, "upstream_unavailable", ""},
		{"200 unparseable", func(w http.ResponseWriter, r *http.Request) { writeRaw(w, 200, "<html>maintenance</html>") },
			503, "upstream_protocol_changed", ""},
		{"unexplained 400", func(w http.ResponseWriter, r *http.Request) { writeRaw(w, 400, "bad request") },
			503, "upstream_protocol_changed", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			g.setStream(c.handler)
			rec := postJSON(t, handleChatCompletions, "/v1/chat/completions", chatBody)
			if rec.Code != c.status {
				t.Fatalf("status %d, want %d (%s)", rec.Code, c.status, rec.Body.String())
			}
			typ, code, msg := errorBody(t, rec)
			if code != c.code || msg == "" || typ == "" {
				t.Errorf("error body: type=%q code=%q msg=%q, want code %q", typ, code, msg, c.code)
			}
			if got := rec.Header().Get("Retry-After"); got != c.retryAfter {
				t.Errorf("Retry-After = %q, want %q", got, c.retryAfter)
			}
		})
	}

	t.Run("success", func(t *testing.T) {
		g.setStream(func(w http.ResponseWriter, r *http.Request) { writeRaw(w, 200, okRaw) })
		rec := postJSON(t, handleChatCompletions, "/v1/chat/completions", chatBody)
		if rec.Code != 200 || !strings.Contains(rec.Body.String(), "banana") {
			t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
		}
	})
}

func TestE2EResponsesStatusMapping(t *testing.T) {
	withRuntime(t, nil)
	resetBLState(t)
	g := newFakeGoogle(t)
	g.setStream(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "9")
		writeRaw(w, 429, "")
	})

	rec := postJSON(t, handleResponses, "/v1/responses", `{"model":"gemini-3.6-flash","input":"hi"}`)
	if rec.Code != 429 || rec.Header().Get("Retry-After") != "9" {
		t.Fatalf("non-stream: status %d, Retry-After %q", rec.Code, rec.Header().Get("Retry-After"))
	}
	if _, code, _ := errorBody(t, rec); code != "upstream_rate_limited" {
		t.Errorf("code = %q", code)
	}

	// A stream has already sent 200 by the time Google fails: the class travels in the event.
	rec = postJSON(t, handleResponses, "/v1/responses", `{"model":"gemini-3.6-flash","input":"hi","stream":true}`)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "response.failed") ||
		!strings.Contains(rec.Body.String(), `"code":"upstream_rate_limited"`) {
		t.Errorf("stream failure event lacks the class: %d %s", rec.Code, rec.Body.String())
	}
}

// Client mistakes stay 400; a login-only model without any usable cookie is 503 no_valid_account.
func TestE2ERejections(t *testing.T) {
	withRuntime(t, nil)
	resetBLState(t)

	rec := postJSON(t, handleChatCompletions, "/v1/chat/completions", `not json`)
	if rec.Code != 400 {
		t.Errorf("invalid JSON: status %d", rec.Code)
	}
	rec = postJSON(t, handleChatCompletions, "/v1/chat/completions",
		`{"model":"no-such-model","messages":[{"role":"user","content":"hi"}]}`)
	if rec.Code != 400 {
		t.Errorf("unknown model: status %d", rec.Code)
	}
	rec = postJSON(t, handleChatCompletions, "/v1/chat/completions",
		`{"model":"gemini-3.6-flash","n":2,"messages":[{"role":"user","content":"hi"}]}`)
	if rec.Code != 400 {
		t.Errorf("n=2: status %d", rec.Code)
	}
	rec = postJSON(t, handleChatCompletions, "/v1/chat/completions",
		`{"model":"gemini-3.6-flash","messages":[]}`)
	if rec.Code != 400 {
		t.Errorf("empty prompt: status %d", rec.Code)
	}

	if hasCookie() {
		t.Skip("cookie pool is not empty")
	}
	rec = postJSON(t, handleChatCompletions, "/v1/chat/completions",
		`{"model":"gemini-3.1-pro","messages":[{"role":"user","content":"hi"}]}`)
	if rec.Code != 503 {
		t.Fatalf("login-only model without cookie: status %d (%s)", rec.Code, rec.Body.String())
	}
	if _, code, _ := errorBody(t, rec); code != "no_valid_account" {
		t.Errorf("code = %q, want no_valid_account", code)
	}
}

// Failures that arrive after the stream started travel inside the stream with the class.
func TestSSEFailCarriesClass(t *testing.T) {
	rec := httptest.NewRecorder()
	s := newSSEWriter(rec, "id", 1, "m")
	s.SendContent("partial")
	ae := apiErrorFor(newUpstreamError(ClassUnavailable, 0, "upstream HTTP 500: x"))
	s.Fail(ae)
	out := rec.Body.String()
	if !strings.Contains(out, `"code":"upstream_unavailable"`) || !strings.Contains(out, "[DONE]") {
		t.Errorf("stream failure chunk: %s", out)
	}
}

// A client disconnect must cancel the Google call (and free the slot).
func TestE2EContextCancelStopsUpstreamCall(t *testing.T) {
	withRuntime(t, nil)
	resetBLState(t)
	g := newFakeGoogle(t)
	started := make(chan struct{})
	sawCancel := make(chan struct{})
	g.setStream(func(w http.ResponseWriter, r *http.Request) {
		// Read the body first: the server only notices a vanished client once it has.
		_, _ = io.Copy(io.Discard, r.Body)
		close(started)

		select {
		case <-r.Context().Done():
			close(sawCancel)
		case <-time.After(20 * time.Second):
		}
	})

	ctx, cancel := context.WithCancel(context.Background())
	type result struct {
		err  error
		took time.Duration
	}
	done := make(chan result, 1)
	t0 := time.Now()
	go func() {
		_, err := streamGenerate(ctx, "hi", "hi", Models["gemini-3.6-flash"], nil, nil)
		done <- result{err, time.Since(t0)}
	}()
	select {
	case <-started:
	case <-time.After(10 * time.Second):
		t.Fatal("upstream was never called")
	}
	cancel()

	select {
	case r := <-done:
		if !errors.Is(r.err, context.Canceled) {
			t.Fatalf("err = %v, want context canceled", r.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("generation did not stop after the client went away")
	}
	select {
	case <-sawCancel:
	case <-time.After(5 * time.Second):
		t.Error("the upstream connection was not closed")
	}
	if u := slotUsage(0); u.Inflight != 0 {
		t.Errorf("slot not released: inflight=%d", u.Inflight)
	}
}

// request_timeout_sec bounds control requests only: a slow generation must outlive it.
func TestE2EGenerationHasNoTotalTimeout(t *testing.T) {
	withRuntime(t, func(c *RuntimeConfig) { c.RequestTimeout = 1 })
	resetBLState(t)
	g := newFakeGoogle(t)
	slow := func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(2500 * time.Millisecond)
		writeRaw(w, 200, okRaw)
	}
	g.setStream(slow)
	g.setApp(slow)

	res, err := streamGenerate(context.Background(), "hi", "hi", Models["gemini-3.6-flash"], nil, nil)
	if err != nil {
		t.Fatalf("generation slower than request_timeout_sec failed: %v", err)
	}
	if extractResponseText(res.Raw) != "banana" {
		t.Errorf("unexpected answer")
	}

	// The same slow server through the control client hits the 1 s limit.
	_, err = fetchAppPage("", "")
	if err == nil {
		t.Fatal("control request should have timed out")
	}
	if upstreamClassOf(err) != ClassUnavailable {
		t.Errorf("control timeout should be classified upstream_unavailable: %v", err)
	}
}

func TestClientTimeoutModel(t *testing.T) {
	withRuntime(t, func(c *RuntimeConfig) { c.RequestTimeout = 42 })
	ctl, gen := getStdlibClient("http://127.0.0.1:9"), getStdlibGenClient("http://127.0.0.1:9")
	if ctl.Timeout != 42*time.Second {
		t.Errorf("control client timeout = %s, want 42s", ctl.Timeout)
	}
	if gen.Timeout != 0 {
		t.Errorf("generation client must have no total timeout, got %s", gen.Timeout)
	}
	if ctl == gen {
		t.Error("control and generation clients must be distinct")
	}
	for _, c := range []*http.Client{ctl, gen} {
		tr := c.Transport.(*http.Transport)
		if tr.DialContext == nil {
			t.Error("stdlib transport lost its keepalive dialer")
		}
		if tr.ResponseHeaderTimeout != 0 {
			t.Error("a response-header timeout would cut Google's thinking time")
		}
	}
	if getTLSClient() == getTLSGenClient() {
		t.Error("tls control and generation clients must be distinct")
	}
	if upstreamKeepAlive != 30*time.Second {
		t.Errorf("keepalive = %s, want 30s", upstreamKeepAlive)
	}
}

// An unexplained 400 triggers one bl re-scrape and a retry that does not spend an attempt.
func TestE2EStaleBLSelfHeals(t *testing.T) {
	withRuntime(t, func(c *RuntimeConfig) { c.GeminiBLAuto = true })
	resetBLState(t)
	g := newFakeGoogle(t)
	g.setApp(func(w http.ResponseWriter, r *http.Request) {
		writeRaw(w, 200, `<html>..."cfb2h":"`+e2eNewBL+`","x":1...</html>`)
	})
	var seen []string
	var mu sync.Mutex
	g.setStream(func(w http.ResponseWriter, r *http.Request) {
		bl := r.URL.Query().Get("bl")
		mu.Lock()
		seen = append(seen, bl)
		mu.Unlock()
		if bl == e2eNewBL {
			writeRaw(w, 200, okRaw)
			return
		}
		writeRaw(w, 400, "stale build")
	})

	rec := postJSON(t, handleChatCompletions, "/v1/chat/completions", chatBody)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "banana") {
		t.Fatalf("request should succeed after the bl refresh: %d %s", rec.Code, rec.Body.String())
	}
	mu.Lock()
	gotSeen := append([]string(nil), seen...)
	mu.Unlock()
	if len(gotSeen) != 2 || gotSeen[0] != e2eOldBL || gotSeen[1] != e2eNewBL {
		t.Errorf("bl sequence = %v, want [old new]", gotSeen)
	}
	if g.appHits.Load() != 1 {
		t.Errorf("/app scraped %d times, want 1", g.appHits.Load())
	}
	if !hasEvent(EventBLChanged) {
		t.Errorf("bl change was not logged; events: %v", eventKinds())
	}
	if age, src := blStatus(); src != "auto" || age == nil {
		t.Errorf("blStatus = %v %q, want auto with an age", age, src)
	}

	// Within the 5-minute floor a second failure must not scrape again.
	g.setStream(func(w http.ResponseWriter, r *http.Request) { writeRaw(w, 400, "still broken") })
	rec = postJSON(t, handleChatCompletions, "/v1/chat/completions", chatBody)
	if rec.Code != 503 {
		t.Fatalf("status %d", rec.Code)
	}
	if _, code, _ := errorBody(t, rec); code != "upstream_protocol_changed" {
		t.Errorf("code = %q", code)
	}
	if g.appHits.Load() != 1 {
		t.Errorf("bl re-scraped inside the floor: %d /app hits", g.appHits.Load())
	}
	if !hasEvent(EventProtocolParseFail) {
		t.Errorf("protocol failure was not logged; events: %v", eventKinds())
	}
}

// With gemini_bl_auto off the pinned value is authoritative: nothing is scraped.
func TestForceRefreshBLRespectsAutoSwitchAndFloor(t *testing.T) {
	withRuntime(t, func(c *RuntimeConfig) { c.GeminiBLAuto = false })
	resetBLState(t)
	g := newFakeGoogle(t)
	g.setApp(func(w http.ResponseWriter, r *http.Request) { writeRaw(w, 200, `"cfb2h":"`+e2eNewBL+`"`) })

	if forceRefreshBL("") {
		t.Error("auto off: must not refresh")
	}
	if g.appHits.Load() != 0 {
		t.Error("auto off: must not scrape")
	}
	if age, src := blStatus(); age != nil || src != "config" {
		t.Errorf("blStatus = %v %q, want config/nil", age, src)
	}

	withRuntime(t, func(c *RuntimeConfig) { c.GeminiBLAuto = true })
	if !forceRefreshBL("") {
		t.Error("first forced refresh should report a change")
	}
	if forceRefreshBL("") {
		t.Error("second forced refresh inside the 5-minute floor must be refused")
	}
	if g.appHits.Load() != 1 {
		t.Errorf("/app hits = %d, want 1", g.appHits.Load())
	}
	// Same value again (after the floor) is not a change and logs nothing new.
	blMu.Lock()
	blForcedAt = time.Time{}
	blMu.Unlock()
	if forceRefreshBL("") {
		t.Error("unchanged bl must not report a change")
	}
}
