package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// resetRepairState gives a test a clean learned state, last-repair record, event
// log and account table, and restores a clean state afterwards.
func resetRepairState(t *testing.T) {
	t.Helper()
	isolateHealthState(t)
	reset := func() {
		setLearned(repairState{})
		_ = kvSet(repairStateKey, "")
		_ = kvSet(lastRepairKey, "")
	}
	reset()
	t.Cleanup(reset)
}

func withAdminToken(t *testing.T, tok string) {
	t.Helper()
	old := cfg.AdminToken
	cfg.AdminToken = tok
	t.Cleanup(func() { cfg.AdminToken = old })
}

func bearer(tok string) map[string]string { return map[string]string{"Authorization": "Bearer " + tok} }

func doReq(h http.HandlerFunc, method, target, body string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h(rec, req)
	return rec
}

const goodBL = "boq_gemini-web-uiserver_20261016.04_p0"

func factsBody(extra string) string {
	return `{"kind":"page_facts","bl":"` + goodBL + `","signed_in":true,"captured_at":"2026-10-17T10:00:00.000Z"` + extra + `}`
}

// ─── context ─────────────────────────────────────────────────────────────────

func TestRepairContextAuth(t *testing.T) {
	resetRepairState(t)
	h := requireAdminBearer(handleRepairContext)

	// Without an admin token the endpoint is closed, not open.
	withAdminToken(t, "")
	if rec := doReq(h, "GET", "/admin/api/repair/context", "", nil); rec.Code != 403 {
		t.Errorf("no admin token configured: %d, want 403", rec.Code)
	}

	withAdminToken(t, "s3cret-admin")
	if rec := doReq(h, "GET", "/admin/api/repair/context", "", nil); rec.Code != 401 {
		t.Errorf("no credentials: %d, want 401", rec.Code)
	}
	if rec := doReq(h, "GET", "/admin/api/repair/context", "", bearer("wrong")); rec.Code != 401 {
		t.Errorf("wrong bearer: %d, want 401", rec.Code)
	}
	// A URL token or an admin session cookie is not enough for the secrets endpoint.
	if rec := doReq(h, "GET", "/admin/api/repair/context?token=s3cret-admin", "", nil); rec.Code != 401 {
		t.Errorf("?token=: %d, want 401", rec.Code)
	}
	tok := newSessionToken()
	createSession(tok, time.Hour)
	if rec := doReq(h, "GET", "/admin/api/repair/context", "", map[string]string{"Cookie": sessionCookieName + "=" + tok}); rec.Code != 401 {
		t.Errorf("session cookie: %d, want 401", rec.Code)
	}
	if countEvents(EventRepairContextServed) != 0 {
		t.Error("a refused request must not log a served context")
	}
	if rec := doReq(h, "GET", "/admin/api/repair/context", "", bearer("s3cret-admin")); rec.Code != 200 {
		t.Errorf("admin bearer: %d, want 200", rec.Code)
	}
	if rec := doReq(h, "POST", "/admin/api/repair/context", "", bearer("s3cret-admin")); rec.Code != 405 {
		t.Errorf("POST: %d, want 405", rec.Code)
	}
}

func TestRepairContextPicksHealthiestAccount(t *testing.T) {
	resetRepairState(t)
	withAdminToken(t, "tok")
	h := requireAdminBearer(handleRepairContext)

	// Nothing in the pool: an empty cookie list (anonymous repair).
	rec := doReq(h, "GET", "/admin/api/repair/context", "", bearer("tok"))
	var ctx struct {
		Cookies      []repairCookie `json:"cookies"`
		AccountID    *string        `json:"account_id"`
		CanaryPrompt string         `json:"canary_prompt"`
		CanaryExpect string         `json:"canary_expect"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &ctx); err != nil || rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	if ctx.Cookies == nil || len(ctx.Cookies) != 0 || ctx.AccountID != nil {
		t.Errorf("empty pool: %+v (%s)", ctx, rec.Body.String())
	}
	if ctx.CanaryPrompt != "Reply with exactly one word: pong" || ctx.CanaryExpect != "pong" {
		t.Errorf("canary spec: %q / %q", ctx.CanaryPrompt, ctx.CanaryExpect)
	}

	bad, _ := accountAdd("bad", "SID=bad-sid; SAPISID=bad-sapisid", "")
	good, _ := accountAdd("good", "SID=good-sid-VALUE; SAPISID=good-sapisid; __Secure-1PSID=g.a000=padding==", "")
	off, _ := accountAdd("off", "SID=off-sid", "")
	_, _ = getDB().Exec(`UPDATE accounts SET fail_count=3 WHERE id=?`, bad)
	_ = accountSetStatus(off, "disabled")
	_, _ = getDB().Exec(`UPDATE accounts SET last_used_at=0 WHERE id=?`, good)

	rec = doReq(h, "GET", "/admin/api/repair/context", "", bearer("tok"))
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Errorf("Cache-Control = %q", rec.Header().Get("Cache-Control"))
	}
	ctx.Cookies, ctx.AccountID = nil, nil
	if err := json.Unmarshal(rec.Body.Bytes(), &ctx); err != nil {
		t.Fatal(err)
	}
	if ctx.AccountID == nil || *ctx.AccountID != repairAccountRef(good) {
		t.Fatalf("account_id = %v, want %s", ctx.AccountID, repairAccountRef(good))
	}
	got := map[string]repairCookie{}
	for _, c := range ctx.Cookies {
		got[c.Name] = c
		if c.Domain != ".google.com" || c.Path != "/" || !c.Secure || !c.HTTPOnly {
			t.Errorf("cookie %s attributes: %+v", c.Name, c)
		}
	}
	if len(got) != 3 || got["SID"].Value != "good-sid-VALUE" || got["__Secure-1PSID"].Value != "g.a000=padding==" {
		t.Errorf("cookies: %+v", ctx.Cookies)
	}
	// Reading a context is not a use of the account.
	if a := accountByID(good); a.LastUsedAt != 0 {
		t.Errorf("last_used_at changed to %d", a.LastUsedAt)
	}

	// The event names the account and nothing else: no cookie value anywhere.
	var served []EventRow
	for _, e := range listEvents(50) {
		if e.Kind == EventRepairContextServed {
			served = append(served, e)
		}
	}
	if len(served) != 2 || served[0].Detail != "account="+repairAccountRef(good) || served[1].Detail != "account=none" {
		t.Errorf("events: %+v", served)
	}
	for _, e := range listEvents(50) {
		if strings.Contains(e.Detail, "VALUE") || strings.Contains(e.Detail, "sapisid") {
			t.Errorf("event leaks a cookie: %+v", e)
		}
	}
}

// ─── events ──────────────────────────────────────────────────────────────────

func TestAdminEventsPost(t *testing.T) {
	isolateHealthState(t)
	ok := doReq(handleAdminEvents, "POST", "/admin/api/events", `{"kind":"repair_started","detail":"job start"}`, nil)
	var res struct {
		OK      bool  `json:"ok"`
		EventID int64 `json:"event_id"`
	}
	if ok.Code != 200 || json.Unmarshal(ok.Body.Bytes(), &res) != nil || !res.OK || res.EventID == 0 {
		t.Fatalf("%d %s", ok.Code, ok.Body.String())
	}
	if evs := listEvents(5); len(evs) != 1 || evs[0].Kind != "repair_started" || evs[0].Detail != "job start" || evs[0].ID != res.EventID {
		t.Errorf("stored: %+v", evs)
	}
	for name, body := range map[string]string{
		"not json":     `nope`,
		"kind upper":   `{"kind":"Repair","detail":""}`,
		"kind short":   `{"kind":"ab","detail":""}`,
		"kind digits":  `{"kind":"repair1","detail":""}`,
		"kind long":    `{"kind":"` + strings.Repeat("a", 41) + `","detail":""}`,
		"kind missing": `{"detail":"x"}`,
		"detail long":  `{"kind":"repair_started","detail":"` + strings.Repeat("x", 501) + `"}`,
	} {
		if rec := doReq(handleAdminEvents, "POST", "/admin/api/events", body, nil); rec.Code != 400 {
			t.Errorf("%s: %d, want 400", name, rec.Code)
		}
	}
	// 500 characters (not bytes) are fine.
	if rec := doReq(handleAdminEvents, "POST", "/admin/api/events",
		`{"kind":"repair_started","detail":"`+strings.Repeat("ü", 500)+`"}`, nil); rec.Code != 200 {
		t.Errorf("500 runes: %d", rec.Code)
	}
}

// ─── learned ─────────────────────────────────────────────────────────────────

func TestRepairLearnedValidation(t *testing.T) {
	resetRepairState(t)
	withRuntime(t, nil)
	stubCanary(t, func(ctx context.Context) (string, *StreamResult, error) {
		t.Error("an invalid report must not reach the canary")
		return "pong", nil, nil
	})

	cases := map[string]string{
		"not json":         `[`,
		"wrong kind":       `{"kind":"protocol","bl":"` + goodBL + `","signed_in":true,"captured_at":"2026-10-17T10:00:00Z"}`,
		"bad bl shape":     `{"kind":"page_facts","bl":"boq_x","signed_in":true,"captured_at":"2026-10-17T10:00:00Z"}`,
		"bl with junk":     `{"kind":"page_facts","bl":"` + goodBL + `\n","signed_in":true,"captured_at":"2026-10-17T10:00:00Z"}`,
		"no signed_in":     `{"kind":"page_facts","bl":"` + goodBL + `","captured_at":"2026-10-17T10:00:00Z"}`,
		"bad captured_at":  `{"kind":"page_facts","bl":"` + goodBL + `","signed_in":true,"captured_at":"yesterday"}`,
		"nothing to learn": `{"kind":"page_facts","signed_in":true,"captured_at":"2026-10-17T10:00:00Z"}`,
		"bad model id":     factsBody(`,"models":[{"id":"has space","label":"3.6 Flash"}]`),
		"empty label":      factsBody(`,"models":[{"id":"fbb127bbb056c959","label":"  "}]`),
		"models not list":  factsBody(`,"models":"x"`),
		"account_id obj":   factsBody(`,"account_id":{"a":1}`),
	}
	for name, body := range cases {
		rec := doReq(handleRepairLearned, "POST", "/admin/api/repair/learned", body, nil)
		var r learnedResponse
		_ = json.Unmarshal(rec.Body.Bytes(), &r)
		if rec.Code != 400 || r.OK || r.Error == "" {
			t.Errorf("%s: %d %s", name, rec.Code, rec.Body.String())
		}
	}
	if rec := doReq(handleRepairLearned, "GET", "/admin/api/repair/learned", "", nil); rec.Code != 405 {
		t.Errorf("GET: %d", rec.Code)
	}
	if getLearned().BL != "" || loadLastRepair() != nil {
		t.Error("rejected reports must change nothing")
	}
}

func TestRepairLearnedAdoptsAfterCanary(t *testing.T) {
	resetRepairState(t)
	withRuntime(t, nil)
	addTestAccount(t, "adopt-login")
	resetBLState(t)

	var seenBL, seenHex string
	stubCanary(t, func(ctx context.Context) (string, *StreamResult, error) {
		// The staged values are what the canary runs with.
		seenBL = currentBL("")
		_, mc, _ := resolveModel("gemini-3.6-flash")
		seenHex = mc.HexID
		return "pong", nil, nil
	})

	const newHex = "aaaaaaaaaaaaaaaa"
	body := factsBody(`,"account_id":"acc-1","models":[
		{"id":"` + newHex + `","label":"3.6 Flash"},
		{"id":"cf41b0e0dd7d53e5","label":"Gemini 3.5  Flash-Lite"},
		{"id":"zzzz","label":"Mystery model"}]`)
	rec := doReq(handleRepairLearned, "POST", "/admin/api/repair/learned", body, nil)
	var r learnedResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &r); err != nil || rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	if !r.OK || !r.Validated || r.Error != "" || r.EventID == 0 {
		t.Fatalf("%+v", r)
	}
	if seenBL != goodBL || seenHex != newHex {
		t.Errorf("canary ran with bl=%q hex=%q, want the staged %q / %q", seenBL, seenHex, goodBL, newHex)
	}

	// Adopted: used by the request path, listed in /healthz, event row = response id.
	if currentBL("") != goodBL {
		t.Errorf("currentBL = %q", currentBL(""))
	}
	for _, id := range []string{"gemini-3.6-flash", "gemini-3.6-flash-thinking"} {
		if _, mc, _ := resolveModel(id); mc.HexID != newHex || mc.ID != id {
			t.Errorf("%s: hex %q id %q", id, mc.HexID, mc.ID)
		}
	}
	// The Flash-Lite entry has the catalogue hex already: no override.
	if _, mc, _ := resolveModel("gemini-3.5-flash-lite"); mc.HexID != hexFlashLite || mc.catalogHex != "" {
		t.Errorf("flash-lite: %+v", mc)
	}
	var ev EventRow
	for _, e := range listEvents(20) {
		if e.Kind == EventRepairAdopted {
			ev = e
		}
	}
	if ev.ID != r.EventID || !strings.Contains(ev.Detail, goodBL) || !strings.Contains(ev.Detail, "adopted=2") || !strings.Contains(ev.Detail, "unknown=1") {
		t.Errorf("event: %+v (response event_id %d)", ev, r.EventID)
	}
	_, h := getHealth(t)
	lr := h["last_repair"].(map[string]interface{})
	if lr["ok"] != true || lr["kind"] != "page_facts" || lr["at"].(float64) == 0 {
		t.Errorf("healthz last_repair: %v", lr)
	}
	if bl := h["bl"].(map[string]interface{}); bl["source"] != "repair" {
		t.Errorf("healthz bl: %v", bl)
	}

	// It survives a restart.
	setLearned(repairState{})
	if currentBL("") == goodBL {
		t.Fatal("test setup: state not cleared")
	}
	loadLearned()
	if currentBL("") != goodBL {
		t.Errorf("after reload currentBL = %q", currentBL(""))
	}
	if _, mc, _ := resolveModel("gemini-3.6-flash"); mc.HexID != newHex {
		t.Errorf("after reload hex = %q", mc.HexID)
	}

	// A bl the operator pins in the panel wins over the learned one.
	next := rtCfg()
	next.RetentionDays = 30
	next.GeminiBL = "boq_pinned-service_20270202.02_p0"
	t.Cleanup(func() { _ = kvSet(runtimeConfigKey, "") })
	if err := saveRuntimeConfig(next); err != nil {
		t.Fatal(err)
	}
	if currentBL("") != next.GeminiBL {
		t.Errorf("pinned bl should win after saving, got %q", currentBL(""))
	}
}

func TestRepairLearnedRollsBackWhenCanaryFails(t *testing.T) {
	resetRepairState(t)
	withRuntime(t, nil)
	addTestAccount(t, "rollback-login")
	resetBLState(t)

	// An earlier repair is in place; the new report must not clobber it on failure.
	setLearned(repairState{BL: "boq_earlier-service_20260901.01_p0", At: time.Now().Unix()})

	stubCanary(t, func(ctx context.Context) (string, *StreamResult, error) {
		if currentBL("") != goodBL {
			t.Errorf("canary did not see the staged bl: %q", currentBL(""))
		}
		return "", nil, newUpstreamError(ClassProtocolChanged, 400, "upstream HTTP 400")
	})
	rec := doReq(handleRepairLearned, "POST", "/admin/api/repair/learned",
		factsBody(`,"models":[{"id":"aaaaaaaaaaaaaaaa","label":"4 Argon"}]`), nil)
	var r learnedResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &r); err != nil || rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	if !r.OK || r.Validated || !strings.Contains(r.Error, "upstream_protocol_changed") || r.EventID == 0 {
		t.Fatalf("%+v", r)
	}
	if currentBL("") != "boq_earlier-service_20260901.01_p0" {
		t.Errorf("rollback: currentBL = %q", currentBL(""))
	}
	if _, mc, _ := resolveModel("gemini-4-argon"); mc.HexID != hexArgon4 {
		t.Errorf("rollback: argon hex = %q", mc.HexID)
	}
	if kvGet(repairStateKey) != "" {
		t.Error("nothing may be persisted for an unvalidated report")
	}
	if !hasEvent(EventRepairUnvalidated) || hasEvent(EventRepairAdopted) {
		t.Errorf("events: %v", eventKinds())
	}
	if lr := loadLastRepair(); lr == nil || lr.OK {
		t.Errorf("last_repair = %+v", lr)
	}
	// The failed canary is also the truth about the direct path.
	if c := loadLastCanary(); c == nil || c.OK || c.ErrorClass != "upstream_protocol_changed" {
		t.Errorf("last canary: %+v", c)
	}
}

func TestRepairLearnedCanaryBusyAndConcurrent(t *testing.T) {
	resetRepairState(t)
	withRuntime(t, nil)
	stubCanary(t, func(ctx context.Context) (string, *StreamResult, error) { return "pong", nil, nil })

	// Another canary in flight: not validated, nothing adopted.
	canaryMu.Lock()
	rec := doReq(handleRepairLearned, "POST", "/admin/api/repair/learned", factsBody(""), nil)
	canaryMu.Unlock()
	var r learnedResponse
	_ = json.Unmarshal(rec.Body.Bytes(), &r)
	if rec.Code != 200 || r.Validated || !strings.Contains(r.Error, "already running") || getLearned().BL != "" {
		t.Errorf("busy canary: %d %+v", rec.Code, r)
	}

	// Another report being validated: 409.
	repairMu.Lock()
	rec = doReq(handleRepairLearned, "POST", "/admin/api/repair/learned", factsBody(""), nil)
	repairMu.Unlock()
	if rec.Code != 409 {
		t.Errorf("concurrent report: %d, want 409", rec.Code)
	}
}

func TestPlanModelOverrides(t *testing.T) {
	const a, b, c = "aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb", "cccccccccccccccc"
	plan := planModelOverrides([]factModel{
		{ID: a, Label: "3.6 Flash"},
		{ID: a, Label: " 3.6   flash "}, // the same entry twice is not a conflict
		{ID: b, Label: "4 Argon"},
		{ID: c, Label: "4 Argon"}, // two ids for one family: ambiguous, not adopted
		{ID: "dddddddddddddddd", Label: "3.1 Pro"},
		{ID: "dddddddddddddddd", Label: "3.8 Flash"}, // one id claimed by two families: both skipped
		{ID: "short", Label: "3.5 Flash-Lite"},       // not a 16-hex id
		{ID: "eeeeeeeeeeeeeeee", Label: "Something else"},
	})
	if plan.Matched != 1 || plan.Ambiguous != 3 || plan.Unknown != 2 {
		t.Errorf("counts: %+v", plan)
	}
	for _, id := range []string{"gemini-3.6-flash", "gemini-3.6-flash-thinking"} {
		if plan.Hex[id] != a {
			t.Errorf("%s -> %q", id, plan.Hex[id])
		}
	}
	for _, id := range []string{"gemini-4-argon", "gemini-3.1-pro", "gemini-3.8-flash", "gemini-3.7-flash-thinking", "gemini-3.5-flash-lite"} {
		if _, ok := plan.Hex[id]; ok {
			t.Errorf("%s must not be adopted", id)
		}
	}

	// A family's aliases and thinking siblings move together.
	p2 := planModelOverrides([]factModel{{ID: b, Label: "Gemini 3.8 Flash"}})
	for _, id := range []string{"gemini-3.8-flash", "gemini-3.8-flash-thinking", "gemini-3.7-flash", "gemini-3.7-flash-thinking"} {
		if p2.Hex[id] != b {
			t.Errorf("%s -> %q", id, p2.Hex[id])
		}
	}
}

// An overridden hex must not turn a login-only model into an anonymous one.
func TestHexOverrideKeepsLoginRequirement(t *testing.T) {
	resetRepairState(t)
	withRuntime(t, nil)
	addTestAccount(t, "override-login")
	setLearned(repairState{Hex: map[string]string{"gemini-3.1-pro": "aaaaaaaaaaaaaaaa"}})
	_, mc, err := resolveModel("gemini-3.1-pro")
	if err != nil || mc.HexID != "aaaaaaaaaaaaaaaa" || mc.catalogHex != hexPro31 {
		t.Fatalf("%+v %v", mc, err)
	}
	if !modelNeedsLogin(mc) {
		t.Error("3.1 Pro with an overridden hex must still need a login")
	}
	// An override equal to the catalogue value is no override.
	setLearned(repairState{Hex: map[string]string{"gemini-3.1-pro": hexPro31}})
	if _, mc, _ = resolveModel("gemini-3.1-pro"); mc.catalogHex != "" || mc.HexID != hexPro31 {
		t.Errorf("%+v", mc)
	}
}

func TestLoadLearnedDropsGarbage(t *testing.T) {
	resetRepairState(t)
	_ = kvSet(repairStateKey, `{"bl":"not-a-bl","hex":{"gemini-3.6-flash":"nothex","no-such-model":"aaaaaaaaaaaaaaaa","gemini-4-argon":"bbbbbbbbbbbbbbbb"},"at":5}`)
	loadLearned()
	s := getLearned()
	if s.BL != "" || len(s.Hex) != 1 || s.Hex["gemini-4-argon"] != "bbbbbbbbbbbbbbbb" {
		t.Errorf("%+v", s)
	}
	_ = kvSet(repairStateKey, `{broken`)
	setLearned(repairState{})
	loadLearned() // must not panic or adopt anything
	if getLearned().BL != "" {
		t.Error("unreadable state adopted")
	}
}
