package app

// Browser transport fallback.
//
// The direct path speaks Google's private web protocol. When Google changes it
// (upstream_protocol_changed) the repair container's `serve` mode can still answer:
// it drives a real browser session on gemini.google.com. This file sends a
// generation there when
//
//   - a direct generation failed with upstream_protocol_changed, or
//   - the last canary failed with that class (the direct attempt is skipped
//     first; it stays the last resort if the browser fails),
//
// and browser_fallback_url is set and the browser's GET /healthz says ok.
// The canary itself always runs the direct path, so health reports the truth.
//
// Contract with repair/serve.mjs:
//
//	GET  {url}/healthz   -> {"ok":true,"signed_in":bool,"queue":n}
//	POST {url}/generate  Authorization: Bearer $BROWSER_FALLBACK_TOKEN
//	     {prompt, model_label, attachments:[{name,mime,data_b64}], json:bool}
//	  -> 200 {"text", "model_label_seen", "json_valid"?}
//	  -> 4xx/5xx {"error":{"code","message"}}  codes: upstream_rate_limited (429),
//	     upstream_unavailable, upstream_protocol_changed, no_valid_account (503),
//	     invalid_request / model_not_found (400), unauthorized (401), payload_too_large (413)
//
// Limits of this transport: no streaming (the answer arrives whole, the bridge's
// streaming APIs send it in one piece), no thinking variants (the browser picks the
// model by label only), no media models, at most 8 attachments, and requests are
// answered one at a time by the browser job.

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"time"
)

const (
	browserFallbackTokenEnv = "BROWSER_FALLBACK_TOKEN"
	browserMaxAttachments   = 8
	browserHealthTimeout    = 5 * time.Second
	browserMaxResponseBytes = 32 << 20

	// browserTransportName is what the request log shows in proxy_name for a
	// generation the browser answered (a direct one shows its proxy, or nothing).
	browserTransportName = "browser"
)

// browserHTTP has no overall Timeout: a generation is bounded by the caller's
// context and generationCeiling. It ignores proxy environment variables; the
// browser job is an internal address.
var browserHTTP = &http.Client{Transport: &http.Transport{
	Proxy:                 nil,
	DialContext:           (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
	MaxIdleConnsPerHost:   2,
	IdleConnTimeout:       60 * time.Second,
	ResponseHeaderTimeout: 0,
}}

func browserFallbackURL() string {
	return strings.TrimRight(strings.TrimSpace(rtCfg().BrowserFallbackURL), "/")
}

func browserFallbackToken() string { return os.Getenv(browserFallbackTokenEnv) }

// validateBrowserFallbackURL accepts "" (off) or a plain http(s) base URL.
func validateBrowserFallbackURL(raw string) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return fmt.Errorf("browser_fallback_url must be an http(s) URL such as http://gemini-web-browser.internal:9000")
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return fmt.Errorf("browser_fallback_url must not carry credentials, a query or a fragment")
	}
	return nil
}

// ─── transport statistics (for /healthz) ─────────────────────────────────────

// transportStats is process-local: it restarts with the bridge.
var transportStats struct {
	directState      atomic.Int32 // 0 = no direct attempt yet, 1 = last one ok, 2 = last one failed
	browserUsedLast  atomic.Int32 // 0 = no generation yet, 1 = last one answered by the browser, 2 = by the direct path
	browserLastUsed  atomic.Int64 // unix seconds of the last browser answer
	browserRequests  atomic.Int64 // browser answers since start
	directOKRequests atomic.Int64 // direct answers since start
}

func noteDirectResult(err error) {
	switch {
	case err == nil:
		transportStats.directState.Store(1)
		transportStats.browserUsedLast.Store(2)
		transportStats.directOKRequests.Add(1)
	case upstreamClassOf(err) != "":
		transportStats.directState.Store(2)
	}
}

func noteBrowserAnswer() {
	transportStats.browserUsedLast.Store(1)
	transportStats.browserLastUsed.Store(time.Now().Unix())
	transportStats.browserRequests.Add(1)
}

// ─── client ──────────────────────────────────────────────────────────────────

type browserAttachment struct {
	Name    string `json:"name"`
	Mime    string `json:"mime"`
	DataB64 string `json:"data_b64"`
}

type browserRequest struct {
	Prompt      string              `json:"prompt"`
	ModelLabel  string              `json:"model_label,omitempty"`
	Attachments []browserAttachment `json:"attachments,omitempty"`
	JSON        bool                `json:"json"`
}

type browserAnswer struct {
	Text           string `json:"text"`
	ModelLabelSeen string `json:"model_label_seen"`
}

// browserHealthy asks the browser job whether it is ready.
func browserHealthy(ctx context.Context, base string) bool {
	ctx, cancel := context.WithTimeout(ctx, browserHealthTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/healthz", nil)
	if err != nil {
		return false
	}
	resp, err := browserHTTP.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	var h struct {
		OK bool `json:"ok"`
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	return resp.StatusCode == http.StatusOK && json.Unmarshal(body, &h) == nil && h.OK
}

// browserLabelFor is the web picker label for a model id ("" = the browser
// transport cannot serve it). The thinking variants share the family's label.
func browserLabelFor(modelID string) string {
	if fam, _, ok := familyOf(modelID); ok {
		return fam.WebLabel
	}
	return ""
}

// browserEligible says whether this request may go through the browser at all.
func browserEligible(mc ModelConfig, attachments int) bool {
	return browserFallbackURL() != "" && mc.Tool == 0 && browserLabelFor(mc.ID) != "" &&
		attachments <= browserMaxAttachments
}

// browserError maps an error answer of the browser job to an UpstreamError, so
// apiErrorFor treats it like any other upstream failure: 429 upstream_rate_limited
// (+ Retry-After), 503 for the rest, with the browser's own code kept in the text.
func browserError(status int, header http.Header, body []byte) *UpstreamError {
	var eb struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(body, &eb)
	code := eb.Error.Code
	detail := fmt.Sprintf("browser fallback: HTTP %d %s: %s", status, code, truncate(eb.Error.Message, 200))
	class := ClassUnavailable
	switch {
	case status == http.StatusTooManyRequests || code == string(ClassRateLimited):
		e := newUpstreamError(ClassRateLimited, status, "%s", detail)
		e.RetryAfter = parseRetryAfter(header.Get("Retry-After"), "")
		if e.RetryAfter == 0 {
			e.RetryAfter = defaultRetryAfterSec
		}
		return e
	case code == string(ClassNoAccount):
		class = ClassNoAccount
	case code == string(ClassProtocolChanged):
		class = ClassProtocolChanged
	case status == http.StatusUnauthorized:
		detail = "browser fallback: the bridge's BROWSER_FALLBACK_TOKEN was rejected"
	}
	return newUpstreamError(class, status, "%s", detail)
}

// browserGenerate sends one generation to the browser job. Prompts and answers
// are never logged.
func browserGenerate(ctx context.Context, base string, mc ModelConfig, prompt string, atts []pendingUpload, wantJSON bool) (string, *StreamResult, error) {
	reqBody := browserRequest{Prompt: prompt, ModelLabel: browserLabelFor(mc.ID), JSON: wantJSON}
	for _, a := range atts {
		reqBody.Attachments = append(reqBody.Attachments, browserAttachment{
			Name: a.Name, Mime: a.Mime, DataB64: base64.StdEncoding.EncodeToString(a.Data),
		})
	}
	payload, err := json.Marshal(reqBody)
	if err != nil {
		return "", nil, err
	}

	t0 := time.Now()
	genCtx, cancel := context.WithTimeout(ctx, generationCeiling)
	defer cancel()
	req, err := http.NewRequestWithContext(genCtx, http.MethodPost, base+"/generate", bytes.NewReader(payload))
	if err != nil {
		return "", nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+browserFallbackToken())
	resp, err := browserHTTP.Do(req)
	if err != nil {
		return "", nil, classifyTransportError(ctx, "browser fallback", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, browserMaxResponseBytes))
	if err != nil {
		return "", nil, classifyTransportError(ctx, "browser fallback body", err)
	}
	if resp.StatusCode != http.StatusOK {
		return "", nil, browserError(resp.StatusCode, resp.Header, body)
	}
	var ans browserAnswer
	if json.Unmarshal(body, &ans) != nil {
		return "", nil, newUpstreamError(ClassUnavailable, resp.StatusCode, "browser fallback: answer is not JSON")
	}
	if strings.TrimSpace(ans.Text) == "" {
		return "", nil, newUpstreamError(ClassUnavailable, resp.StatusCode, "browser fallback: empty answer")
	}
	ms := time.Since(t0).Milliseconds()
	return ans.Text, &StreamResult{
		UpstreamModel: ans.ModelLabelSeen,
		ProxyName:     browserTransportName,
		TTFBMs:        ms,
		TotalMs:       ms,
	}, nil
}

// ─── orchestration ───────────────────────────────────────────────────────────

// directFunc is one direct-path attempt. It reports streamed output through the
// callbacks it is given.
type directFunc func(ctx context.Context, onDelta, onReasoning func(string)) (string, []ToolCall, *StreamResult, error)

// lastCanaryProtocolChanged: the direct path is known to be broken.
func lastCanaryProtocolChanged() bool {
	c := loadLastCanary()
	return c != nil && !c.OK && c.ErrorClass == string(ClassProtocolChanged)
}

// generateWithFallback runs a generation on the direct path and, when Google's
// protocol is the problem, on the browser transport (see the file comment).
// prompt is what the browser gets; wantJSON asks its answer to be JSON.
func generateWithFallback(ctx context.Context, j generationJob, prompt string, wantJSON bool,
	onDelta, onReasoning func(string), direct directFunc) (string, []ToolCall, *StreamResult, error) {

	eligible := browserEligible(j.Model, len(j.Attachments))
	var browserErr error    // the error of a browser attempt that did not answer
	browserChecked := false // the browser was asked once for this request

	// attempt returns usable=false when the browser is not ready (nothing was sent).
	attempt := func(why string) (text string, calls []ToolCall, res *StreamResult, err error, usable bool) {
		browserChecked = true
		base := browserFallbackURL()
		if !browserHealthy(ctx, base) {
			return "", nil, nil, nil, false
		}
		text, res, err = browserGenerate(ctx, base, j.Model, prompt, j.Attachments, wantJSON)
		if err != nil {
			logf("[browser] fallback failed (%s): %v", why, err)
			return "", nil, nil, err, true
		}
		if len(j.Tools) > 0 {
			text, calls = parseToolCalls(text)
		}
		noteBrowserAnswer()
		logEventThrottled(EventBrowserFallback, why+"; answered by the browser transport", time.Minute)
		return text, calls, res, nil, true
	}

	if eligible && lastCanaryProtocolChanged() {
		text, calls, res, err, usable := attempt("last canary failed: " + string(ClassProtocolChanged))
		if usable && err == nil {
			return text, calls, res, nil
		}
		if err != nil {
			browserErr = err
		}
	}

	// Streaming output cannot be taken back: once something went out, a failure
	// is final.
	var sent atomic.Bool
	wrap := func(f func(string)) func(string) {
		if f == nil {
			return nil
		}
		return func(s string) { sent.Store(true); f(s) }
	}
	text, calls, res, err := direct(ctx, wrap(onDelta), wrap(onReasoning))
	noteDirectResult(err)
	if err == nil {
		return text, calls, res, nil
	}

	if eligible && !browserChecked && !sent.Load() && ctx.Err() == nil && upstreamClassOf(err) == ClassProtocolChanged {
		btext, bcalls, bres, berr, usable := attempt("direct path failed: " + string(ClassProtocolChanged))
		if usable && berr == nil {
			return btext, bcalls, bres, nil
		}
		if berr != nil {
			browserErr = berr
		}
	}
	// A rate limit or a missing account reported by the browser says more than
	// the protocol error that sent us there; other browser failures do not.
	if c := upstreamClassOf(browserErr); upstreamClassOf(err) == ClassProtocolChanged && (c == ClassRateLimited || c == ClassNoAccount) {
		return "", nil, res, browserErr
	}
	return "", nil, res, err
}
