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
	"testing"
	"time"
)

func TestClassifyHTTPFailure(t *testing.T) {
	future := time.Now().Add(90 * time.Second).UTC().Format(http.TimeFormat)
	cases := []struct {
		name       string
		status     int
		body       string
		location   string
		retryAfter string
		signedIn   bool
		wantNil    bool
		want       ErrClass
		wantRetry  int // 0 = don't care unless want is RateLimited
		wantExact  int
	}{
		{name: "200 is fine", status: 200, wantNil: true},
		{name: "429 default retry", status: 429, want: ClassRateLimited, wantExact: 60},
		{name: "429 retry-after seconds", status: 429, retryAfter: "30", want: ClassRateLimited, wantExact: 30},
		{name: "429 retry-after date", status: 429, retryAfter: future, want: ClassRateLimited, wantRetry: 1},
		{name: "429 retry hint in body", status: 429, body: "please retry in 45s", want: ClassRateLimited, wantExact: 45},
		{name: "429 retry-after clamped", status: 429, retryAfter: "99999999", want: ClassRateLimited, wantExact: maxRetryAfterSec},
		{name: "302 to sorry", status: 302, location: "https://www.google.com/sorry/index?continue=x",
			want: ClassRateLimited, wantExact: sorryRetryAfterSec},
		{name: "302 sorry only in body", status: 302, body: `<A HREF="https://www.google.com/sorry/index">here</A>`,
			want: ClassRateLimited, wantExact: sorryRetryAfterSec},
		{name: "302 sign-in with cookie", status: 302, location: "https://accounts.google.com/ServiceLogin", signedIn: true, want: ClassNoAccount},
		{name: "302 sign-in anonymous", status: 302, location: "https://accounts.google.com/ServiceLogin", want: ClassUnavailable},
		{name: "400 RESOURCE_EXHAUSTED text", status: 400, body: `{"error":{"status":"RESOURCE_EXHAUSTED"}}`,
			want: ClassRateLimited, wantExact: 60},
		{name: "403 quota text", status: 403, body: "You exceeded your current quota", want: ClassRateLimited, wantExact: 60},
		{name: "400 usage limit text", status: 400, body: "usage limit reached", want: ClassRateLimited, wantExact: 60},
		{name: "400 unexplained", status: 400, body: "bad", want: ClassProtocolChanged},
		{name: "404", status: 404, want: ClassProtocolChanged},
		{name: "401 with cookie", status: 401, signedIn: true, want: ClassNoAccount},
		{name: "403 with cookie", status: 403, signedIn: true, want: ClassNoAccount},
		{name: "403 anonymous", status: 403, want: ClassUnavailable},
		{name: "500", status: 500, want: ClassUnavailable},
		{name: "502", status: 502, want: ClassUnavailable},
		{name: "503", status: 503, want: ClassUnavailable},
		{name: "500 with quota text stays unavailable", status: 500, body: "quota", want: ClassUnavailable},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ue := classifyHTTPFailure(c.status, c.body, c.location, c.retryAfter, c.signedIn)
			if c.wantNil {
				if ue != nil {
					t.Fatalf("want nil, got %+v", ue)
				}
				return
			}
			if ue == nil {
				t.Fatal("got nil")
			}
			if ue.Class != c.want {
				t.Fatalf("class = %s, want %s (%s)", ue.Class, c.want, ue.Error())
			}
			if c.wantExact != 0 && ue.RetryAfter != c.wantExact {
				t.Errorf("RetryAfter = %d, want %d", ue.RetryAfter, c.wantExact)
			}
			if c.wantRetry != 0 && (ue.RetryAfter < c.wantRetry || ue.RetryAfter > 100) {
				t.Errorf("RetryAfter = %d, want within (0,100]", ue.RetryAfter)
			}
			if ue.Class != ClassRateLimited && ue.RetryAfter != 0 {
				t.Errorf("RetryAfter should only be set for rate limits, got %d", ue.RetryAfter)
			}
		})
	}
}

func TestClassifyEmptyAnswer(t *testing.T) {
	if ue := classifyEmptyAnswer([]byte(rejectedRaw)); ue.Class != ClassUnavailable ||
		!strings.Contains(ue.Error(), "no content frame") {
		t.Errorf("rejected frame: %+v", ue)
	}
	if ue := classifyEmptyAnswer(nil); ue.Class != ClassUnavailable {
		t.Errorf("empty body: %+v", ue)
	}
	// Google answered with something that is not a wrb.fr stream at all.
	if ue := classifyEmptyAnswer([]byte("<html><body>maintenance</body></html>")); ue.Class != ClassProtocolChanged {
		t.Errorf("html body should be a protocol change: %+v", ue)
	}
	limited := ")]}'\n" + `[["wrb.fr",null,null,null,null,[8,null,[["type.googleapis.com/x","RESOURCE_EXHAUSTED"]]]]]`
	if ue := classifyEmptyAnswer([]byte(limited)); ue.Class != ClassRateLimited || ue.RetryAfter != 60 {
		t.Errorf("quota frame: %+v", ue)
	}
}

// Errors reach the mapper wrapped (fmt.Errorf %w), so the mapping must see through wrapping.
func TestAPIErrorMapping(t *testing.T) {
	ue := func(c ErrClass) error { return newUpstreamError(c, 0, "boom %s", c) }
	rl := newUpstreamError(ClassRateLimited, 429, "upstream HTTP 429: x")
	rl.RetryAfter = 33
	cases := []struct {
		name       string
		err        error
		status     int
		code, typ  string
		retryAfter int
	}{
		{"prompt too long", &PromptTooLongError{Bytes: 10, Budget: 5}, 400, "context_length_exceeded", "invalid_request_error", 0},
		{"local limiter", &RateLimitError{Reason: "rpm"}, 429, "ip_slot_full", "rate_limit_exceeded", 0},
		{"upstream 429", rl, 429, "upstream_rate_limited", "rate_limit_exceeded", 33},
		{"wrapped upstream 429", fmt.Errorf("outer: %w", rl), 429, "upstream_rate_limited", "rate_limit_exceeded", 33},
		{"rate limited without hint", ue(ClassRateLimited), 429, "upstream_rate_limited", "rate_limit_exceeded", defaultRetryAfterSec},
		{"unavailable", ue(ClassUnavailable), 503, "upstream_unavailable", "upstream_error", 0},
		{"protocol", ue(ClassProtocolChanged), 503, "upstream_protocol_changed", "upstream_error", 0},
		{"no account", ue(ClassNoAccount), 503, "no_valid_account", "upstream_error", 0},
		{"client gone", fmt.Errorf("x: %w", context.Canceled), 499, "client_closed_request", "invalid_request_error", 0},
		{"unclassified", errors.New("something odd"), 503, "upstream_unavailable", "upstream_error", 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ae := apiErrorFor(c.err)
			if ae.Status != c.status || ae.Code != c.code || ae.Type != c.typ || ae.RetryAfter != c.retryAfter {
				t.Fatalf("got %+v; want status=%d code=%s type=%s retry=%d", ae, c.status, c.code, c.typ, c.retryAfter)
			}
			if ae.Message == "" {
				t.Error("empty message")
			}
		})
	}
}

func TestWriteAPIErrorBodyAndHeader(t *testing.T) {
	e := newUpstreamError(ClassRateLimited, 302, "upstream HTTP 302: sorry")
	e.RetryAfter = sorryRetryAfterSec
	rec := httptest.NewRecorder()
	writeAPIError(rec, apiErrorFor(e))
	if rec.Code != 429 {
		t.Fatalf("status %d", rec.Code)
	}
	if got := rec.Header().Get("Retry-After"); got != "7200" {
		t.Errorf("Retry-After = %q, want 7200", got)
	}
	var body struct {
		Error struct{ Message, Type, Code string } `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Error.Code != "upstream_rate_limited" || body.Error.Type != "rate_limit_exceeded" || body.Error.Message == "" {
		t.Errorf("body = %s", rec.Body.String())
	}

	rec = httptest.NewRecorder()
	writeAPIError(rec, apiErrorFor(newUpstreamError(ClassUnavailable, 500, "upstream HTTP 500: x")))
	if rec.Code != 503 || rec.Header().Get("Retry-After") != "" {
		t.Errorf("503 should carry no Retry-After: %d %v", rec.Code, rec.Header())
	}
}

// The admin dashboard buckets requests.error text; every class must land in a
// meaningful bucket and the legacy buckets must keep working.
func TestClassifyErrorCoversClasses(t *testing.T) {
	for _, c := range []struct {
		err  error
		want string
	}{
		{classifyHTTPFailure(429, "", "", "", false), "upstream_429"},
		{classifyHTTPFailure(302, "", "https://www.google.com/sorry/index", "", false), "blocked_sorry"},
		{classifyHTTPFailure(400, "RESOURCE_EXHAUSTED", "", "", false), "upstream_rate_limited"},
		{classifyHTTPFailure(500, "x", "", "", false), "upstream_http_error"},
		{classifyHTTPFailure(400, "x", "", "", false), "upstream_http_error"},
		{classifyEmptyAnswer([]byte(rejectedRaw)), "upstream_rejected"},
		{classifyEmptyAnswer([]byte("<html>")), "upstream_protocol_changed"},
		{errNoAccount("no valid account: nothing usable"), "no_valid_account"},
		{cookieExhaustedError(2, errNoAccount("no SNlM0e in page")), "no_valid_account"},
		{generationCtxError(context.Background(), expiredCtx(t)), "upstream_timeout"},
		{context.Canceled, "client_closed"},
	} {
		if got := classifyError(c.err.Error()); got != c.want {
			t.Errorf("classifyError(%q) = %q, want %q", c.err.Error(), got, c.want)
		}
	}
}

func expiredCtx(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	t.Cleanup(cancel)
	return ctx
}

// A client that went away is not an upstream failure; the safety ceiling is.
func TestGenerationCtxError(t *testing.T) {
	if err := generationCtxError(context.Background(), context.Background()); err != nil {
		t.Errorf("live contexts: %v", err)
	}
	gone, cancel := context.WithCancel(context.Background())
	cancel()
	if err := generationCtxError(gone, gone); !errors.Is(err, context.Canceled) {
		t.Errorf("client gone: %v", err)
	}
	err := generationCtxError(context.Background(), expiredCtx(t))
	if upstreamClassOf(err) != ClassUnavailable || !strings.Contains(err.Error(), "safety ceiling") {
		t.Errorf("ceiling hit: %v", err)
	}
	if generationCeiling != 600*time.Second {
		t.Errorf("generation ceiling = %s, want 10m", generationCeiling)
	}
}

func TestCookieExhaustedErrorClass(t *testing.T) {
	cases := []struct {
		last error
		want ErrClass
	}{
		{errNoAccount("no SNlM0e in page"), ClassNoAccount},
		{newUpstreamError(ClassRateLimited, 429, "fetch /app: HTTP 429"), ClassRateLimited},
		{errUnavailable("fetch /app", errors.New("connection reset")), ClassUnavailable},
		{errors.New("untyped"), ClassUnavailable},
	}
	for _, c := range cases {
		if got := cookieExhaustedError(3, c.last); got.Class != c.want {
			t.Errorf("last=%v: class %s, want %s", c.last, got.Class, c.want)
		}
	}
	if got := cookieExhaustedError(3, errNoAccount("x")); !strings.Contains(got.Error(), "no valid account") {
		t.Errorf("message lost its marker: %s", got.Error())
	}
}

// Transport failures are upstream_unavailable, but a canceled context passes through.
func TestClassifyTransportError(t *testing.T) {
	boom := errors.New("connection reset by peer")
	if ue, ok := classifyTransportError(context.Background(), "request", boom).(*UpstreamError); !ok || ue.Class != ClassUnavailable {
		t.Errorf("network error should be upstream_unavailable")
	}
	gone, cancel := context.WithCancel(context.Background())
	cancel()
	if err := classifyTransportError(gone, "request", boom); !errors.Is(err, context.Canceled) {
		t.Errorf("canceled ctx should pass through, got %v", err)
	}
}

func TestBodyCap(t *testing.T) {
	old := maxRequestBodyBytes
	if old != 80<<20 {
		t.Errorf("default cap should be 80 MB, got %d", old)
	}
	maxRequestBodyBytes = 1024
	t.Cleanup(func() { maxRequestBodyBytes = old })

	h := capBody(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := io.ReadAll(r.Body); err != nil {
			writeBodyReadError(w, err)
			return
		}
		w.WriteHeader(204)
	}))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(strings.Repeat("a", 4096))))
	if rec.Code != 413 {
		t.Fatalf("oversize body: status %d, want 413", rec.Code)
	}
	var body struct {
		Error struct{ Message, Type, Code string } `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body.Error.Code != "request_too_large" ||
		body.Error.Type != "invalid_request_error" || body.Error.Message == "" {
		t.Errorf("413 body not OpenAI-shaped: %s", rec.Body.String())
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(strings.Repeat("a", 512))))
	if rec.Code != 204 {
		t.Errorf("body under the cap: status %d, want 204", rec.Code)
	}
}

// An unreachable or throttled token page is not the pool's fault: the message
// must not claim "no valid account" (the admin dashboard buckets on that text).
func TestCookieExhaustedMessageFollowsClass(t *testing.T) {
	down := cookieExhaustedError(2, errUnavailable("fetch /app", errors.New("connection reset")))
	if down.Class != ClassUnavailable || strings.Contains(down.Error(), "no valid account") {
		t.Errorf("unreachable token page: %s / %s", down.Class, down.Error())
	}
	if got := classifyError(down.Error()); got == "no_valid_account" {
		t.Errorf("dashboard bucket = %q", got)
	}
	expired := cookieExhaustedError(2, errNoAccount("no SNlM0e in page"))
	if expired.Class != ClassNoAccount || !strings.Contains(expired.Error(), "no valid account") {
		t.Errorf("expired cookies: %s / %s", expired.Class, expired.Error())
	}
}
