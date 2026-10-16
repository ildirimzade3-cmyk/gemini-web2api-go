package app

// Health surface for monitoring and for the Miraz fork's operators:
//   - GET /healthz: unauthenticated, secret-free JSON summary, 200 / 503.
//   - the canary: a tiny fixed prompt sent through the normal generation path,
//     on a schedule (canary_interval_min) and on demand (POST /admin/api/canary).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	canaryPrompt = "Reply with the single word: pong"
	canaryKVKey  = "last_canary"
	// canaryWantSubstr is what a healthy answer to canaryPrompt must contain.
	canaryWantSubstr = "pong"
	// canaryWrongAnswer is the error class of an answer that came back but is not the expected one.
	canaryWrongAnswer = "unexpected_answer"
)

// CanaryResult is the outcome of one canary run, persisted in kv as JSON.
type CanaryResult struct {
	OK         bool   `json:"ok"`
	At         int64  `json:"at"` // unix seconds
	ErrorClass string `json:"error_class,omitempty"`
	LatencyMs  int64  `json:"latency_ms"`
	// Skipped: the run could not reach Google because the local limiter was full.
	// Skipped runs say nothing about Google's health and are not persisted.
	Skipped bool `json:"skipped,omitempty"`
}

// canaryGenerate sends the canary prompt through the normal path. A variable so
// tests can stand in for Google.
var canaryGenerate = func(ctx context.Context) (string, *StreamResult, error) {
	_, mc, err := resolveModel(rtCfg().DefaultModel)
	if err != nil {
		return "", nil, err
	}
	text, _, res, err := callGemini(ctx, canaryPrompt, canaryPrompt, mc, nil, nil, nil, nil)
	return text, res, err
}

var canaryMu sync.Mutex

func loadLastCanary() *CanaryResult {
	raw := kvGet(canaryKVKey)
	if raw == "" {
		return nil
	}
	var c CanaryResult
	if json.Unmarshal([]byte(raw), &c) != nil {
		return nil
	}
	return &c
}

func saveCanary(c CanaryResult) {
	b, _ := json.Marshal(c)
	if err := kvSet(canaryKVKey, string(b)); err != nil {
		logf("[canary] save failed: %v", err)
	}
}

// canaryErrorClass names a failure for the canary record and /healthz.
func canaryErrorClass(err error) string {
	var rle *RateLimitError
	switch {
	case errors.As(err, &rle):
		return "ip_slot_full"
	case errors.Is(err, context.Canceled):
		return "canceled"
	}
	if c := upstreamClassOf(err); c != "" {
		return string(c)
	}
	return string(ClassUnavailable)
}

// runCanary runs one canary. started is false when another run is in flight.
// The result is persisted and state changes (failure, recovery) are written to
// the event log.
func runCanary(ctx context.Context) (res CanaryResult, started bool) {
	if !canaryMu.TryLock() {
		return CanaryResult{}, false
	}
	defer canaryMu.Unlock()

	prev := loadLastCanary()
	t0 := time.Now()
	text, sres, err := canaryGenerate(ctx)
	// A web model occasionally answers the fixed prompt with something else
	// (seen once in the 17 Oct VPS repair run). One immediate re-ask keeps a
	// single odd answer from failing the canary or rolling back a repair; a
	// transport or protocol error is reported as it is.
	if err == nil && !strings.Contains(strings.ToLower(text), canaryWantSubstr) {
		logf("[canary] unexpected answer (%d chars), asking once more", len([]rune(text)))
		text, sres, err = canaryGenerate(ctx)
	}
	res = CanaryResult{At: t0.Unix(), LatencyMs: time.Since(t0).Milliseconds()}

	switch {
	case err != nil:
		res.ErrorClass = canaryErrorClass(err)
	case !strings.Contains(strings.ToLower(text), canaryWantSubstr):
		res.ErrorClass = canaryWrongAnswer
	default:
		res.OK = true
	}

	status, errStr := 200, ""
	switch {
	case err != nil:
		status, errStr = apiErrorFor(err).Status, err.Error()
	case !res.OK:
		status, errStr = http.StatusBadGateway, "canary: "+canaryWrongAnswer
	}

	// Exactly like real traffic: the canary shows up in the request stats.
	recordRequest("canary", rtCfg().DefaultModel, canaryPrompt, text, sres, status, errStr, false)

	if res.ErrorClass == "ip_slot_full" {
		res.Skipped = true
		return res, true
	}
	saveCanary(res)
	switch {
	case !res.OK && (prev == nil || prev.OK || prev.ErrorClass != res.ErrorClass):
		LogEvent(EventCanaryFailed, fmt.Sprintf("class=%s latency=%dms", res.ErrorClass, res.LatencyMs))
	case res.OK && prev != nil && !prev.OK:
		LogEvent(EventCanaryRecovered, fmt.Sprintf("was %s, latency=%dms", prev.ErrorClass, res.LatencyMs))
	}
	return res, true
}

// maybeRunCanary is the scheduler hook (ticks every minute): it runs a canary
// when canary_interval_min is set and the last result is at least that old.
func maybeRunCanary() {
	iv := rtCfg().CanaryIntervalMin
	if iv <= 0 {
		return
	}
	if last := loadLastCanary(); last != nil &&
		time.Since(time.Unix(last.At, 0)) < time.Duration(iv)*time.Minute {
		return
	}
	runCanary(context.Background())
}

// handleAdminCanary serves POST /admin/api/canary: run a canary now.
func handleAdminCanary(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, 405, map[string]string{"error": "method not allowed"})
		return
	}
	res, started := runCanary(r.Context())
	if !started {
		writeJSON(w, 409, map[string]string{"error": "a canary is already running"})
		return
	}
	writeJSON(w, 200, res)
}

// ─── /healthz ───────────────────────────────────────────────────────────────

// healthStatus is the /healthz payload. It carries counts and states only:
// no cookies, keys, prompts or answers.
type healthStatus struct {
	Status   string `json:"status"` // "ok" | "unhealthy"
	Version  string `json:"version"`
	Accounts struct {
		Total   int `json:"total"`
		Enabled int `json:"enabled"`
		// Healthy = enabled with no consecutive failures.
		Healthy int `json:"healthy"`
	} `json:"accounts"`
	BL struct {
		// ValueAgeSeconds is the age of the auto-scraped bl; null while the
		// pinned config value is in use (its age is unknown).
		ValueAgeSeconds *int64 `json:"value_age_seconds"`
		Source          string `json:"source"` // "auto" | "config"
	} `json:"bl"`
	// XSRFOKLast is whether the most recent login-token fetch worked; null if none yet.
	XSRFOKLast *bool         `json:"xsrf_ok_last"`
	LastCanary *CanaryResult `json:"last_canary"`
	// LastRepair is the outcome of the most recent self-repair report (repair.go); null if none.
	LastRepair *LastRepair `json:"last_repair"`
	// BrowserFallback: whether the browser transport is configured and when it last answered.
	BrowserFallback struct {
		Configured bool   `json:"configured"`
		LastUsedAt *int64 `json:"last_used_at"` // unix seconds since this process started; null = not yet
	} `json:"browser_fallback"`
	// Transport says which path answered lately (process-local counters, null = no data yet).
	Transport struct {
		DirectOKLast    *bool `json:"direct_ok_last"`    // the last direct attempt worked
		BrowserUsedLast *bool `json:"browser_used_last"` // the last answer came from the browser
		BrowserAnswers  int64 `json:"browser_answers"`   // browser answers since start
		DirectAnswers   int64 `json:"direct_answers"`    // direct answers since start
	} `json:"transport"`
	Problems []string `json:"problems,omitempty"`
}

// buildHealth assembles the report and the HTTP status: 200 when at least one
// healthy account exists (or the deployment runs anonymously by design or via
// fallback_anon) and the last canary did not fail; 503 otherwise.
func buildHealth() (int, healthStatus) {
	var h healthStatus
	h.Version = Version
	h.Accounts.Total, h.Accounts.Enabled, h.Accounts.Healthy = accountHealthCounts()
	h.BL.ValueAgeSeconds, h.BL.Source = blStatus()
	h.XSRFOKLast = xsrfLastOK()
	h.LastCanary = loadLastCanary()
	h.LastRepair = loadLastRepair()
	fillTransportHealth(&h)

	anon := h.Accounts.Total == 0 || rtCfg().FallbackAnon
	if h.Accounts.Healthy == 0 && !anon {
		h.Problems = append(h.Problems, "no healthy account and anonymous fallback is off")
	}
	if h.LastCanary != nil && !h.LastCanary.OK {
		h.Problems = append(h.Problems, "last canary failed: "+h.LastCanary.ErrorClass)
	}
	if len(h.Problems) > 0 {
		h.Status = "unhealthy"
		return http.StatusServiceUnavailable, h
	}
	h.Status = "ok"
	return http.StatusOK, h
}

func handleHealthz(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeJSON(w, 405, map[string]string{"error": "method not allowed"})
		return
	}
	code, h := buildHealth()
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, code, h)
}

// fillTransportHealth reports the browser fallback and the transport counters.
func fillTransportHealth(h *healthStatus) {
	h.BrowserFallback.Configured = browserFallbackURL() != ""
	if at := transportStats.browserLastUsed.Load(); at > 0 {
		h.BrowserFallback.LastUsedAt = &at
	}
	switch transportStats.directState.Load() {
	case 1:
		t := true
		h.Transport.DirectOKLast = &t
	case 2:
		f := false
		h.Transport.DirectOKLast = &f
	}
	switch transportStats.browserUsedLast.Load() {
	case 1:
		t := true
		h.Transport.BrowserUsedLast = &t
	case 2:
		f := false
		h.Transport.BrowserUsedLast = &f
	}
	h.Transport.BrowserAnswers = transportStats.browserRequests.Load()
	h.Transport.DirectAnswers = transportStats.directOKRequests.Load()
}
