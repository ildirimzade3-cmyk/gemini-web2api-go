package app

// Typed upstream failures and the single place that turns any error into an
// HTTP status + OpenAI-style error body.
//
// Why: every Google-side failure used to surface as a generic 502, so a caller
// could not tell "wait a minute" (rate limit) from "this proxy has no usable
// account" from "Google changed the protocol". Failures are now classified where
// they are detected (gemini.go / conversation.go / xsrf.go / upload.go) and
// mapped in apiErrorFor, nowhere else.

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// ErrClass is the machine-readable failure class. The string is also the
// OpenAI error "code" returned to clients.
type ErrClass string

const (
	// ClassRateLimited: Google throttled us (HTTP 429, quota/usage-limit text,
	// or the 302 -> google.com/sorry bot block). Maps to 429 + Retry-After.
	ClassRateLimited ErrClass = "upstream_rate_limited"
	// ClassUnavailable: 5xx, network errors, empty answers. Maps to 503.
	ClassUnavailable ErrClass = "upstream_unavailable"
	// ClassProtocolChanged: Google answered, but not in a shape we understand
	// (unparseable frames, unexplained 400, 404). Maps to 503.
	ClassProtocolChanged ErrClass = "upstream_protocol_changed"
	// ClassNoAccount: no usable cookie (all accounts disabled/expired, XSRF
	// unobtainable). Maps to 503.
	ClassNoAccount ErrClass = "no_valid_account"
)

// Retry-After values (seconds) used when Google does not provide one.
const (
	defaultRetryAfterSec = 60
	sorryRetryAfterSec   = 7200 // an IP on the sorry list stays blocked for hours
	maxRetryAfterSec     = 86400
)

// UpstreamError is a classified failure of a call to Google.
type UpstreamError struct {
	Class      ErrClass
	Status     int    // upstream HTTP status, 0 when there was none
	RetryAfter int    // seconds, only meaningful for ClassRateLimited
	Detail     string // diagnostic text; never contains cookies, prompts or answers
	Err        error  // underlying cause, if any
}

func (e *UpstreamError) Error() string {
	switch {
	case e.Detail != "":
		return e.Detail
	case e.Err != nil:
		return e.Err.Error()
	}
	return string(e.Class)
}

func (e *UpstreamError) Unwrap() error { return e.Err }

func newUpstreamError(class ErrClass, status int, format string, args ...interface{}) *UpstreamError {
	return &UpstreamError{Class: class, Status: status, Detail: fmt.Sprintf(format, args...)}
}

// errNoAccount is the "no usable cookie" error used by the local pre-checks
// (model needs a login, image input needs a login) as well as by the cookie loop.
func errNoAccount(format string, args ...interface{}) *UpstreamError {
	return newUpstreamError(ClassNoAccount, 0, format, args...)
}

// errUnavailable wraps a transport-level failure (DNS, TCP, TLS, reset, read error).
func errUnavailable(what string, cause error) *UpstreamError {
	return &UpstreamError{Class: ClassUnavailable, Detail: what + ": " + cause.Error(), Err: cause}
}

var (
	// Text Google puts in error bodies / frames when a quota is exhausted.
	rateLimitTextRe = regexp.MustCompile(`(?i)resource_exhausted|usage limit|quota|rate[ _-]?limit|too many requests|reached (?:your|the) [a-z ]{0,30}limit`)
	// "retry in 30s", "retry after 30 seconds"
	retryHintRe = regexp.MustCompile(`(?i)retry(?:ing)?\s+(?:in|after)\s+(\d{1,6})\s*(?:s\b|sec)`)
	// BardErrorInfo code carried by a frame without content, e.g. [1155].
	bardErrCodeRe = regexp.MustCompile(`BardErrorInfo",\[(\d+)\]`)
)

// parseRetryAfter reads a Retry-After header (delta-seconds or HTTP-date) and
// falls back to a "retry in Ns" hint in the body. Returns 0 when nothing usable.
func parseRetryAfter(header, body string) int {
	header = strings.TrimSpace(header)
	if header != "" {
		if n, err := strconv.Atoi(header); err == nil && n > 0 {
			return clampRetryAfter(n)
		}
		if t, err := http.ParseTime(header); err == nil {
			if d := int(time.Until(t).Seconds()); d > 0 {
				return clampRetryAfter(d)
			}
		}
	}
	if m := retryHintRe.FindStringSubmatch(body); m != nil {
		if n, err := strconv.Atoi(m[1]); err == nil && n > 0 {
			return clampRetryAfter(n)
		}
	}
	return 0
}

func clampRetryAfter(n int) int {
	if n > maxRetryAfterSec {
		return maxRetryAfterSec
	}
	return n
}

// classifyHTTPFailure classifies a non-200 answer from Google. It returns nil
// for status 200. signedIn says whether the request carried a login cookie
// (401/403 only means "bad account" in that case).
func classifyHTTPFailure(status int, body, location, retryAfterHeader string, signedIn bool) *UpstreamError {
	if status == http.StatusOK {
		return nil
	}
	snip := truncate(body, 200)
	switch {
	case status >= 300 && status < 400:
		loc := strings.ToLower(location)
		if strings.Contains(loc, "/sorry") || strings.Contains(strings.ToLower(body), "google.com/sorry") {
			e := newUpstreamError(ClassRateLimited, status,
				"upstream HTTP %d: redirected to google.com/sorry (bot block on this egress IP)", status)
			e.RetryAfter = sorryRetryAfterSec
			return e
		}
		if strings.Contains(loc, "accounts.google.") {
			if signedIn {
				return newUpstreamError(ClassNoAccount, status,
					"upstream HTTP %d: redirected to the Google sign-in page (cookie expired)", status)
			}
			return newUpstreamError(ClassUnavailable, status,
				"upstream HTTP %d: redirected to the Google sign-in page", status)
		}
		return newUpstreamError(ClassUnavailable, status, "upstream HTTP %d: unexpected redirect", status)
	case status == http.StatusTooManyRequests:
		e := newUpstreamError(ClassRateLimited, status, "upstream HTTP %d: %s", status, snip)
		e.RetryAfter = parseRetryAfter(retryAfterHeader, body)
		if e.RetryAfter == 0 {
			e.RetryAfter = defaultRetryAfterSec
		}
		return e
	case status >= 400 && status < 500 && rateLimitTextRe.MatchString(body):
		e := newUpstreamError(ClassRateLimited, status, "upstream rate limited (HTTP %d): %s", status, snip)
		e.RetryAfter = parseRetryAfter(retryAfterHeader, body)
		if e.RetryAfter == 0 {
			e.RetryAfter = defaultRetryAfterSec
		}
		return e
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		if signedIn {
			return newUpstreamError(ClassNoAccount, status, "upstream HTTP %d: %s", status, snip)
		}
		return newUpstreamError(ClassUnavailable, status, "upstream HTTP %d: %s", status, snip)
	case status == http.StatusBadRequest, status == http.StatusNotFound,
		status == http.StatusMethodNotAllowed, status == http.StatusGone:
		// Our request is well-formed as far as we know, so Google no longer
		// understands it: the protocol (or the bl build id) moved.
		return newUpstreamError(ClassProtocolChanged, status, "upstream HTTP %d: %s", status, snip)
	default:
		return newUpstreamError(ClassUnavailable, status, "upstream HTTP %d: %s", status, snip)
	}
}

// classifyEmptyAnswer classifies an HTTP 200 response that carries no content
// frame. raw is only inspected, never copied into the error.
func classifyEmptyAnswer(raw []byte) *UpstreamError {
	s := string(raw)
	if len(raw) < 8192 && rateLimitTextRe.MatchString(s) {
		e := newUpstreamError(ClassRateLimited, http.StatusOK,
			"upstream rate limited: quota/limit signal in an answer without content (raw %d bytes)", len(raw))
		e.RetryAfter = parseRetryAfter("", s)
		if e.RetryAfter == 0 {
			e.RetryAfter = defaultRetryAfterSec
		}
		return e
	}
	if len(strings.TrimSpace(s)) > 0 && !strings.Contains(s, `"wrb.fr"`) {
		return newUpstreamError(ClassProtocolChanged, http.StatusOK,
			"upstream protocol changed: HTTP 200 without any wrb.fr frame (raw %d bytes)", len(raw))
	}
	code := ""
	if m := bardErrCodeRe.FindStringSubmatch(s); m != nil {
		code = ", code " + m[1]
	}
	return newUpstreamError(ClassUnavailable, http.StatusOK,
		"upstream returned no content frame (raw %d bytes%s)", len(raw), code)
}

// classifyTransportError wraps a client.Do / body-read failure. A canceled or
// expired context is NOT an upstream failure and is returned unchanged so the
// caller can tell "the client went away" from "Google is down".
func classifyTransportError(ctx context.Context, what string, err error) error {
	if err == nil {
		return nil
	}
	if ctx != nil && ctx.Err() != nil {
		return ctx.Err()
	}
	var ue *UpstreamError
	if errors.As(err, &ue) {
		return err
	}
	return errUnavailable(what, err)
}

// upstreamClassOf extracts the class from err, "" when err is not an UpstreamError.
func upstreamClassOf(err error) ErrClass {
	var ue *UpstreamError
	if errors.As(err, &ue) {
		return ue.Class
	}
	return ""
}

// ─── error -> HTTP mapping ───────────────────────────────────────────────────

// apiError is what a client sees for a failed request.
type apiError struct {
	Status     int
	Type       string
	Code       string
	Message    string
	RetryAfter int // seconds; 0 = no Retry-After header
}

// statusClientClosed is nginx's 499, used for the access log only: the client
// that would read the response is already gone.
const statusClientClosed = 499

// apiErrorFor is the single mapping from an internal error to the HTTP status,
// OpenAI error type/code and Retry-After sent to the client.
//
//	PromptTooLongError        -> 400 invalid_request_error / context_length_exceeded
//	RateLimitError (local)    -> 429 rate_limit_exceeded   / ip_slot_full
//	UpstreamError rate limit  -> 429 rate_limit_exceeded   / upstream_rate_limited (+Retry-After)
//	UpstreamError no account  -> 503 upstream_error        / no_valid_account
//	UpstreamError protocol    -> 503 upstream_error        / upstream_protocol_changed
//	UpstreamError unavailable -> 503 upstream_error        / upstream_unavailable
//	client went away          -> 499 (never read by anyone)
//	anything else             -> 503 upstream_error        / upstream_unavailable
func apiErrorFor(err error) apiError {
	var ptl *PromptTooLongError
	var rle *RateLimitError
	var ue *UpstreamError
	switch {
	case errors.As(err, &ptl):
		return apiError{Status: 400, Type: "invalid_request_error", Code: "context_length_exceeded", Message: ptl.Error()}
	case errors.As(err, &rle):
		return apiError{Status: 429, Type: "rate_limit_exceeded", Code: "ip_slot_full", Message: rle.Error()}
	case errors.Is(err, context.Canceled):
		return apiError{Status: statusClientClosed, Type: "invalid_request_error", Code: "client_closed_request", Message: "client closed the request"}
	case errors.As(err, &ue):
		ae := apiError{Type: "upstream_error", Code: string(ue.Class), Message: "upstream error: " + ue.Error()}
		switch ue.Class {
		case ClassRateLimited:
			ae.Status, ae.Type = 429, "rate_limit_exceeded"
			ae.RetryAfter = ue.RetryAfter
			if ae.RetryAfter <= 0 {
				ae.RetryAfter = defaultRetryAfterSec
			}
		default:
			ae.Status = 503
		}
		return ae
	}
	return apiError{Status: 503, Type: "upstream_error", Code: string(ClassUnavailable), Message: "upstream error: " + err.Error()}
}

func (a apiError) body() map[string]interface{} {
	return map[string]interface{}{"error": map[string]string{
		"message": a.Message, "type": a.Type, "code": a.Code,
	}}
}

// writeAPIError writes the mapped error as a normal (non-stream) JSON response.
func writeAPIError(w http.ResponseWriter, ae apiError) {
	if ae.RetryAfter > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(ae.RetryAfter))
	}
	writeJSON(w, ae.Status, ae.body())
}

// writeJSONError is the shape used for plain 4xx rejections that never reach Google.
func writeJSONError(w http.ResponseWriter, status int, typ, code, msg string) {
	writeAPIError(w, apiError{Status: status, Type: typ, Code: code, Message: msg})
}

// maxRequestBodyBytes caps every inbound request body (see capBody). Base64
// images and long agent histories are the legitimate large payloads.
var maxRequestBodyBytes int64 = 80 << 20 // a variable only so a test can lower it

// capBody limits the request body of every route; a read past the limit fails
// with *http.MaxBytesError, which the API handlers turn into a 413.
func capBody(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Body != nil && r.Body != http.NoBody {
			r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodyBytes)
		}
		next.ServeHTTP(w, r)
	})
}

// writeBodyReadError answers a failed body read: 413 when the cap was hit,
// 400 otherwise.
func writeBodyReadError(w http.ResponseWriter, err error) {
	var mbe *http.MaxBytesError
	if errors.As(err, &mbe) {
		writeJSONError(w, http.StatusRequestEntityTooLarge, "invalid_request_error", "request_too_large",
			fmt.Sprintf("request body too large: the limit is %d MB", maxRequestBodyBytes>>20))
		return
	}
	writeJSONError(w, http.StatusBadRequest, "invalid_request_error", "", err.Error())
}

// apiErrorForRejection maps a request that failed local validation before
// reaching Google. A clientError (unsupported or oversized attachment) keeps its
// status (400 / 413); a classified error (e.g. "no valid account" for a
// login-only model) keeps its class; everything else is a client mistake: 400.
func apiErrorForRejection(err error) apiError {
	if ce, ok := errorAsClient(err); ok {
		return apiError{Status: ce.Status, Type: "invalid_request_error", Code: ce.Code, Message: ce.Msg}
	}
	if upstreamClassOf(err) != "" {
		return apiErrorFor(err)
	}
	return apiError{Status: http.StatusBadRequest, Type: "invalid_request_error", Message: err.Error()}
}

// writeRejection answers such a request on the OpenAI routes.
func writeRejection(w http.ResponseWriter, err error) {
	writeAPIError(w, apiErrorForRejection(err))
}
