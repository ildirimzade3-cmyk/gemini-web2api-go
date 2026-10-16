package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

const browserToken = "browser-test-token"

// fakeBrowser stands in for the repair container's serve mode.
type fakeBrowser struct {
	srv *httptest.Server

	mu       sync.Mutex
	healthy  bool
	handler  http.HandlerFunc // POST /generate; nil = a canned answer
	answer   string
	requests []browserRequest
	auth     []string
	gens     int
	healthz  int
}

func newFakeBrowser(t *testing.T) *fakeBrowser {
	t.Helper()
	b := &fakeBrowser{healthy: true, answer: "banana-from-browser"}
	b.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/healthz" && r.Method == "GET":
			b.mu.Lock()
			b.healthz++
			ok := b.healthy
			b.mu.Unlock()
			writeJSON(w, 200, map[string]interface{}{"ok": ok, "signed_in": true, "queue": 0})
		case r.URL.Path == "/generate" && r.Method == "POST":
			var req browserRequest
			_ = json.NewDecoder(r.Body).Decode(&req)
			b.mu.Lock()
			b.gens++
			b.requests = append(b.requests, req)
			b.auth = append(b.auth, r.Header.Get("Authorization"))
			h, ans := b.handler, b.answer
			b.mu.Unlock()
			if h != nil {
				h(w, r)
				return
			}
			writeJSON(w, 200, map[string]interface{}{"text": ans, "model_label_seen": "3.6 Flash"})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(b.srv.Close)
	return b
}

func (b *fakeBrowser) setHandler(h http.HandlerFunc) { b.mu.Lock(); b.handler = h; b.mu.Unlock() }
func (b *fakeBrowser) setAnswer(s string)            { b.mu.Lock(); b.answer = s; b.mu.Unlock() }
func (b *fakeBrowser) calls() int                    { b.mu.Lock(); defer b.mu.Unlock(); return b.gens }
func (b *fakeBrowser) last() browserRequest {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.requests) == 0 {
		return browserRequest{}
	}
	return b.requests[len(b.requests)-1]
}

func browserError503(code string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 503, map[string]interface{}{"error": map[string]string{"code": code, "message": "browser says " + code}})
	}
}

// browserEnv wires a test: runtime config with the fallback URL, the token, a
// fake Google that no longer understands the protocol (unexplained 400), clean
// transport counters and a clean canary record.
func browserEnv(t *testing.T) (*fakeBrowser, *fakeGoogle) {
	t.Helper()
	isolateHealthState(t)
	resetBLState(t)
	b := newFakeBrowser(t)
	withRuntime(t, func(c *RuntimeConfig) { c.BrowserFallbackURL = b.srv.URL })
	t.Setenv(browserFallbackTokenEnv, browserToken)
	g := newFakeGoogle(t)
	g.setStream(func(w http.ResponseWriter, r *http.Request) { writeRaw(w, 400, "unknown request") })
	resetTransportStats(t)
	return b, g
}

func resetTransportStats(t *testing.T) {
	t.Helper()
	reset := func() {
		transportStats.directState.Store(0)
		transportStats.browserUsedLast.Store(0)
		transportStats.browserLastUsed.Store(0)
		transportStats.browserRequests.Store(0)
		transportStats.directOKRequests.Store(0)
	}
	reset()
	t.Cleanup(reset)
}

func maxRequestID() int64 {
	var id int64
	_ = getDB().QueryRow(`SELECT COALESCE(MAX(id),0) FROM requests`).Scan(&id)
	return id
}

// proxyNameOfNewRequest waits for the request-log row written after afterID (rows
// are inserted asynchronously) and returns its proxy_name.
func proxyNameOfNewRequest(t *testing.T, afterID int64, endpoint string) string {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		var name string
		err := getDB().QueryRow(`SELECT COALESCE(proxy_name,'') FROM requests WHERE id > ? AND endpoint=? ORDER BY id DESC LIMIT 1`, afterID, endpoint).Scan(&name)
		if err == nil {
			return name
		}
		if time.Now().After(deadline) {
			t.Fatalf("no request row for %s", endpoint)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestBrowserFallbackAnswersWhenProtocolChanged(t *testing.T) {
	b, g := browserEnv(t)

	after := maxRequestID()
	rec := postJSON(t, handleChatCompletions, "/v1/chat/completions", chatBody)
	if rec.Code != 200 || chatContent(t, rec) != "banana-from-browser" {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	if g.streamHits.Load() == 0 {
		t.Error("the direct path must be tried first")
	}
	req := b.last()
	if b.auth[0] != "Bearer "+browserToken || req.ModelLabel != "3.6 Flash" || req.JSON || !strings.Contains(req.Prompt, "hi") {
		t.Errorf("browser saw auth=%q request=%+v", b.auth[0], req)
	}
	if got := proxyNameOfNewRequest(t, after, "chat.completions"); got != browserTransportName {
		t.Errorf("request log transport = %q, want %q", got, browserTransportName)
	}
	if !hasEvent(EventBrowserFallback) {
		t.Errorf("events: %v", eventKinds())
	}

	_, h := getHealth(t)
	tr := h["transport"].(map[string]interface{})
	bf := h["browser_fallback"].(map[string]interface{})
	if tr["browser_used_last"] != true || tr["direct_ok_last"] != false || tr["browser_answers"] != 1.0 ||
		bf["configured"] != true || bf["last_used_at"] == nil {
		t.Errorf("healthz transport=%v browser_fallback=%v", tr, bf)
	}

	// The thinking variant is asked of the browser by the family's label.
	b.setAnswer("thought")
	addTestAccount(t, "browser-thinking")
	rec = postJSON(t, handleChatCompletions, "/v1/chat/completions",
		`{"model":"gemini-3.8-flash","reasoning_effort":"high","messages":[{"role":"user","content":"hi"}]}`)
	if rec.Code != 200 || b.last().ModelLabel != "3.8 Flash" {
		t.Errorf("thinking variant: %d label=%q", rec.Code, b.last().ModelLabel)
	}
}

func TestBrowserFallbackStreamsTheAnswerWhole(t *testing.T) {
	b, _ := browserEnv(t)
	b.setAnswer("streamed-from-browser")
	rec := postJSON(t, handleChatCompletions, "/v1/chat/completions",
		`{"model":"gemini-3.6-flash","stream":true,"messages":[{"role":"user","content":"hi"}]}`)
	if rec.Code != 200 || strings.Count(rec.Body.String(), "streamed-from-browser") != 1 || !strings.Contains(rec.Body.String(), "[DONE]") {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
}

func TestBrowserFallbackNotUsed(t *testing.T) {
	b, g := browserEnv(t)

	// Other failure classes are not the browser's business.
	g.setStream(func(w http.ResponseWriter, r *http.Request) { writeRaw(w, 500, "oops") })
	rec := postJSON(t, handleChatCompletions, "/v1/chat/completions", chatBody)
	if _, code, _ := errorBody(t, rec); rec.Code != 503 || code != "upstream_unavailable" || b.calls() != 0 {
		t.Errorf("500: %d %s, browser calls %d", rec.Code, code, b.calls())
	}
	g.setStream(func(w http.ResponseWriter, r *http.Request) { writeRaw(w, 429, "") })
	rec = postJSON(t, handleChatCompletions, "/v1/chat/completions", chatBody)
	if rec.Code != 429 || b.calls() != 0 {
		t.Errorf("429: %d, browser calls %d", rec.Code, b.calls())
	}

	// Protocol changed, but the browser is not ready: the original error stands.
	g.setStream(func(w http.ResponseWriter, r *http.Request) { writeRaw(w, 400, "unknown request") })
	b.mu.Lock()
	b.healthy = false
	b.mu.Unlock()
	rec = postJSON(t, handleChatCompletions, "/v1/chat/completions", chatBody)
	if _, code, _ := errorBody(t, rec); rec.Code != 503 || code != "upstream_protocol_changed" || b.calls() != 0 {
		t.Errorf("browser not ready: %d %s, browser calls %d", rec.Code, code, b.calls())
	}

	// Not configured: no browser, no health check.
	b.mu.Lock()
	b.healthy, b.healthz = true, 0
	b.mu.Unlock()
	withRuntime(t, nil)
	rec = postJSON(t, handleChatCompletions, "/v1/chat/completions", chatBody)
	if _, code, _ := errorBody(t, rec); rec.Code != 503 || code != "upstream_protocol_changed" || b.calls() != 0 || b.healthz != 0 {
		t.Errorf("not configured: %d %s, calls %d, healthz %d", rec.Code, code, b.calls(), b.healthz)
	}
	_, h := getHealth(t)
	if h["browser_fallback"].(map[string]interface{})["configured"] != false {
		t.Errorf("healthz: %v", h["browser_fallback"])
	}
}

func TestBrowserFallbackErrorMapping(t *testing.T) {
	b, _ := browserEnv(t)

	// The browser is rate limited: the client sees 429 + Retry-After.
	b.setHandler(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "42")
		writeJSON(w, 429, map[string]interface{}{"error": map[string]string{"code": "upstream_rate_limited", "message": "usage limit"}})
	})
	rec := postJSON(t, handleChatCompletions, "/v1/chat/completions", chatBody)
	if _, code, msg := errorBody(t, rec); rec.Code != 429 || code != "upstream_rate_limited" || rec.Header().Get("Retry-After") != "42" || !strings.Contains(msg, "browser fallback") {
		t.Errorf("429: %d %s %q Retry-After=%q", rec.Code, code, msg, rec.Header().Get("Retry-After"))
	}

	// Not signed in: no_valid_account is more useful than the protocol error.
	b.setHandler(browserError503("no_valid_account"))
	rec = postJSON(t, handleChatCompletions, "/v1/chat/completions", chatBody)
	if _, code, _ := errorBody(t, rec); rec.Code != 503 || code != "no_valid_account" {
		t.Errorf("no_valid_account: %d %s", rec.Code, code)
	}

	// Anything else the browser fails with leaves the original verdict in place.
	for _, code := range []string{"upstream_unavailable", "upstream_protocol_changed", "model_not_found", "weird_code"} {
		b.setHandler(browserError503(code))
		rec = postJSON(t, handleChatCompletions, "/v1/chat/completions", chatBody)
		if _, got, _ := errorBody(t, rec); rec.Code != 503 || got != "upstream_protocol_changed" {
			t.Errorf("browser %s: %d %s, want the direct verdict upstream_protocol_changed", code, rec.Code, got)
		}
	}
	// An empty answer and a non-JSON answer count as failures too.
	b.setHandler(func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]string{"text": "  "}) })
	if rec = postJSON(t, handleChatCompletions, "/v1/chat/completions", chatBody); rec.Code != 503 {
		t.Errorf("empty answer: %d", rec.Code)
	}
	b.setHandler(func(w http.ResponseWriter, r *http.Request) { writeRaw(w, 200, "<html>") })
	if rec = postJSON(t, handleChatCompletions, "/v1/chat/completions", chatBody); rec.Code != 503 {
		t.Errorf("html answer: %d", rec.Code)
	}
}

func TestBrowserErrorClassification(t *testing.T) {
	cases := []struct {
		status     int
		body       string
		retryAfter string
		class      ErrClass
		retry      int
	}{
		{429, `{"error":{"code":"upstream_rate_limited","message":"x"}}`, "30", ClassRateLimited, 30},
		{429, `not json`, "", ClassRateLimited, defaultRetryAfterSec},
		{503, `{"error":{"code":"upstream_rate_limited","message":"x"}}`, "", ClassRateLimited, defaultRetryAfterSec},
		{503, `{"error":{"code":"no_valid_account","message":"x"}}`, "", ClassNoAccount, 0},
		{503, `{"error":{"code":"upstream_protocol_changed","message":"x"}}`, "", ClassProtocolChanged, 0},
		{503, `{"error":{"code":"upstream_unavailable","message":"x"}}`, "", ClassUnavailable, 0},
		{400, `{"error":{"code":"model_not_found","message":"x"}}`, "", ClassUnavailable, 0},
		{401, `{"error":{"code":"unauthorized","message":"x"}}`, "", ClassUnavailable, 0},
		{502, ``, "", ClassUnavailable, 0},
	}
	for _, c := range cases {
		h := http.Header{}
		if c.retryAfter != "" {
			h.Set("Retry-After", c.retryAfter)
		}
		e := browserError(c.status, h, []byte(c.body))
		if e.Class != c.class || e.RetryAfter != c.retry || !strings.HasPrefix(e.Error(), "browser fallback") {
			t.Errorf("HTTP %d %s: %+v", c.status, c.body, e)
		}
	}
}

func TestBrowserFallbackJSONMode(t *testing.T) {
	b, _ := browserEnv(t)
	b.setAnswer("Sure!\n```json\n{\"headline\":\"Budget approved\"}\n```")
	rec := postJSON(t, handleChatCompletions, "/v1/chat/completions",
		`{"model":"gemini-3.6-flash","messages":[{"role":"user","content":"summarise"}],"response_format":{"type":"json_object"}}`)
	if rec.Code != 200 || chatContent(t, rec) != `{"headline":"Budget approved"}` {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	if req := b.last(); !req.JSON || !strings.Contains(req.Prompt, "summarise") || !strings.Contains(req.Prompt, "JSON") {
		t.Errorf("browser request: json=%v prompt=%q", req.JSON, req.Prompt)
	}

	// The bridge's own validation and repair round still apply to the browser's text.
	var n int
	b.setHandler(func(w http.ResponseWriter, r *http.Request) {
		n++
		text := "not json at all"
		if n >= 2 {
			text = `{"ok":true}`
		}
		writeJSON(w, 200, map[string]string{"text": text})
	})
	rec = postJSON(t, handleChatCompletions, "/v1/chat/completions",
		`{"model":"gemini-3.6-flash","messages":[{"role":"user","content":"x"}],"response_format":{"type":"json_object"}}`)
	if rec.Code != 200 || chatContent(t, rec) != `{"ok":true}` || n != 2 {
		t.Errorf("repair round: %d (browser calls %d) %s", rec.Code, n, rec.Body.String())
	}

	// Still invalid after the repair: 503 upstream_invalid_json.
	b.setHandler(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]string{"text": "prose only"})
	})
	rec = postJSON(t, handleChatCompletions, "/v1/chat/completions",
		`{"model":"gemini-3.6-flash","messages":[{"role":"user","content":"x"}],"response_format":{"type":"json_object"}}`)
	if _, code, _ := errorBody(t, rec); rec.Code != 503 || code != "upstream_invalid_json" {
		t.Errorf("invalid after repair: %d %s", rec.Code, code)
	}
}

func TestBrowserFallbackAttachmentsAndToolCalls(t *testing.T) {
	b, _ := browserEnv(t)
	addTestAccount(t, "browser-files")

	body := `{"model":"gemini-3.6-flash","messages":[{"role":"user","content":[
		{"type":"text","text":"read this"},
		{"type":"file","file":{"file_data":"data:text/plain;base64,aGVsbG8=","filename":"note.txt"}}]}]}`
	rec := postJSON(t, handleChatCompletions, "/v1/chat/completions", body)
	if rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	atts := b.last().Attachments
	if len(atts) != 1 || atts[0].Name != "note.txt" || atts[0].Mime != "text/plain" || atts[0].DataB64 != "aGVsbG8=" {
		t.Errorf("attachments: %+v", atts)
	}

	// More attachments than the browser job takes: it is not asked at all.
	before := b.calls()
	var parts []string
	for i := 0; i < browserMaxAttachments+1; i++ {
		parts = append(parts, `{"type":"file","file":{"file_data":"data:text/plain;base64,aGVsbG8=","filename":"f`+string(rune('a'+i))+`.txt"}}`)
	}
	rec = postJSON(t, handleChatCompletions, "/v1/chat/completions",
		`{"model":"gemini-3.6-flash","messages":[{"role":"user","content":[{"type":"text","text":"x"},`+strings.Join(parts, ",")+`]}]}`)
	if rec.Code == 200 || b.calls() != before {
		t.Errorf("too many attachments: %d, browser calls %d -> %d", rec.Code, before, b.calls())
	}

	// Tool calls are parsed from the browser's text like from Google's.
	b.setAnswer("```tool_call\n{\"name\":\"get_weather\",\"arguments\":{\"city\":\"Baku\"}}\n```")
	rec = postJSON(t, handleChatCompletions, "/v1/chat/completions",
		`{"model":"gemini-3.6-flash","messages":[{"role":"user","content":"weather?"}],
		  "tools":[{"type":"function","function":{"name":"get_weather","parameters":{"type":"object","properties":{"city":{"type":"string"}}}}}]}`)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"tool_calls"`) || !strings.Contains(rec.Body.String(), "get_weather") {
		t.Errorf("tool call: %d %s", rec.Code, rec.Body.String())
	}
}

func TestBrowserFirstWhenLastCanaryProtocolChanged(t *testing.T) {
	b, g := browserEnv(t)
	g.setStream(func(w http.ResponseWriter, r *http.Request) { writeRaw(w, 200, okRaw) })
	saveCanary(CanaryResult{OK: false, At: time.Now().Unix(), ErrorClass: string(ClassProtocolChanged)})

	// The direct path is known to be broken: the browser answers, Google is not asked.
	rec := postJSON(t, handleChatCompletions, "/v1/chat/completions", chatBody)
	if rec.Code != 200 || chatContent(t, rec) != "banana-from-browser" || g.streamHits.Load() != 0 {
		t.Fatalf("%d %s (google hits %d)", rec.Code, rec.Body.String(), g.streamHits.Load())
	}

	// If the browser cannot answer, the direct path is the last resort.
	b.setHandler(browserError503("upstream_unavailable"))
	rec = postJSON(t, handleChatCompletions, "/v1/chat/completions", chatBody)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "banana") || g.streamHits.Load() != 1 {
		t.Errorf("browser down: %d %s (google hits %d)", rec.Code, rec.Body.String(), g.streamHits.Load())
	}
	if b.calls() != 2 {
		t.Errorf("browser asked %d times, want once per request", b.calls())
	}

	// A canary that failed for another reason does not reroute traffic.
	saveCanary(CanaryResult{OK: false, At: time.Now().Unix(), ErrorClass: string(ClassUnavailable)})
	before := b.calls()
	if rec = postJSON(t, handleChatCompletions, "/v1/chat/completions", chatBody); rec.Code != 200 || b.calls() != before {
		t.Errorf("unavailable canary: %d, browser calls %d -> %d", rec.Code, before, b.calls())
	}
}

// The canary always tests the direct path, whatever transport traffic uses.
func TestCanaryIgnoresBrowserTransport(t *testing.T) {
	b, _ := browserEnv(t)
	res, started := runCanary(context.Background())
	if !started || res.OK || res.ErrorClass != "upstream_protocol_changed" {
		t.Fatalf("%+v", res)
	}
	if b.calls() != 0 {
		t.Errorf("the canary reached the browser %d times", b.calls())
	}
}

// Output that already went to the client cannot be taken back: no fallback then.
func TestGenerateWithFallbackNeverAfterStreamedOutput(t *testing.T) {
	b, _ := browserEnv(t)
	_, mc, err := resolveModel("gemini-3.6-flash")
	if err != nil {
		t.Fatal(err)
	}
	j := generationJob{Model: mc, Prompt: "hi"}

	var got []string
	_, _, _, err = generateWithFallback(context.Background(), j, "hi", false, func(s string) { got = append(got, s) }, nil,
		func(ctx context.Context, onDelta, _ func(string)) (string, []ToolCall, *StreamResult, error) {
			onDelta("partial")
			return "", nil, nil, newUpstreamError(ClassProtocolChanged, 200, "frames stopped parsing")
		})
	if upstreamClassOf(err) != ClassProtocolChanged || b.calls() != 0 || len(got) != 1 {
		t.Errorf("err=%v browser calls=%d deltas=%v", err, b.calls(), got)
	}

	// Nothing streamed yet: the same failure falls back, and the text comes back whole.
	text, _, res, err := generateWithFallback(context.Background(), j, "hi", false, func(string) {}, nil,
		func(ctx context.Context, onDelta, _ func(string)) (string, []ToolCall, *StreamResult, error) {
			return "", nil, nil, newUpstreamError(ClassProtocolChanged, 200, "frames stopped parsing")
		})
	if err != nil || text != "banana-from-browser" || res == nil || res.ProxyName != browserTransportName || res.Emitted != "" {
		t.Errorf("text=%q res=%+v err=%v", text, res, err)
	}

	// A model the browser cannot serve (no web label) is never sent there.
	media := j
	media.Model = decorateModel("gemini-image", Models["gemini-image"])
	_, _, _, err = generateWithFallback(context.Background(), media, "hi", false, nil, nil,
		func(ctx context.Context, _, _ func(string)) (string, []ToolCall, *StreamResult, error) {
			return "", nil, nil, newUpstreamError(ClassProtocolChanged, 200, "x")
		})
	if err == nil || b.calls() != 1 {
		t.Errorf("media model: err=%v browser calls=%d", err, b.calls())
	}
}

func TestValidateBrowserFallbackURL(t *testing.T) {
	for _, ok := range []string{"", "  ", "http://gemini-web-browser.internal:9000", "https://browser.example.com", "http://127.0.0.1:9000/"} {
		if err := validateBrowserFallbackURL(ok); err != nil {
			t.Errorf("%q rejected: %v", ok, err)
		}
	}
	for _, bad := range []string{"gemini-web-browser:9000", "ftp://x", "http://", "http://user:pw@host", "http://host?x=1", "http://host#f", "javascript:alert(1)"} {
		if err := validateBrowserFallbackURL(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
	withRuntime(t, nil)
	next := rtCfg()
	next.BrowserFallbackURL = "not a url"
	if err := validateRuntimeConfig(next); err == nil {
		t.Error("validateRuntimeConfig accepted a bad browser_fallback_url")
	}
}

func TestHealthzTransportBeforeAnyTraffic(t *testing.T) {
	isolateHealthState(t)
	resetTransportStats(t)
	withRuntime(t, nil)
	_, h := getHealth(t)
	tr := h["transport"].(map[string]interface{})
	bf := h["browser_fallback"].(map[string]interface{})
	if tr["direct_ok_last"] != nil || tr["browser_used_last"] != nil || bf["last_used_at"] != nil || bf["configured"] != false || h["last_repair"] != nil {
		t.Errorf("transport=%v browser_fallback=%v last_repair=%v", tr, bf, h["last_repair"])
	}
	if strings.Contains(strings.ToLower(toJSON(h)), browserToken) {
		t.Error("healthz must not carry the fallback token")
	}
}

func toJSON(v interface{}) string { b, _ := json.Marshal(v); return string(b) }
