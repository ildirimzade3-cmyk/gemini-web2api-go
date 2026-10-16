package app

// Self-repair API.
//
// When Google changes the web protocol the canary (health.go) starts failing.
// A host trigger then starts the repair container (repair/), which drives a real
// headless browser through gemini.google.com and reports what the page shows.
// The bridge never trusts that report blindly: the new values are staged, a
// canary runs through the DIRECT path with them, and they are adopted only if it
// passes; otherwise the previous values are restored.
//
//	GET  /admin/api/repair/context   cookies of the healthiest account + canary spec (admin token only)
//	POST /admin/api/repair/learned   page facts {kind:"page_facts", bl, models, signed_in, captured_at, account_id?}
//	POST /admin/api/events           (events.go) the job's own progress events
//
// What can be learned: the build label (bl) and the model hex ids of the web
// model picker. Both are kept in kv ("repair_learned") and survive a restart.
// A learned bl wins over the pinned and the scraped one until the operator
// changes gemini_bl in the panel (saveRuntimeConfig drops it) or a later repair
// replaces it.

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
)

const (
	repairCanaryPrompt = "Reply with exactly one word: pong"
	repairCanaryExpect = "pong"

	repairStateKey = "repair_learned"
	lastRepairKey  = "last_repair"

	repairKindPageFacts = "page_facts"
	repairMaxModels     = 100
	repairMaxBodyBytes  = 1 << 20
)

// repairCanaryTimeout bounds the validation canary so the repair job (30 s HTTP
// timeout) still gets an answer. A variable so a test can shorten it.
var repairCanaryTimeout = 25 * time.Second

// repairState is what a repair taught the bridge.
type repairState struct {
	BL  string            `json:"bl,omitempty"`
	Hex map[string]string `json:"hex,omitempty"` // our model id -> web model hex id
	At  int64             `json:"at,omitempty"`  // unix seconds of the adoption
}

func (s repairState) clone() repairState {
	out := s
	out.Hex = make(map[string]string, len(s.Hex))
	for k, v := range s.Hex {
		out.Hex[k] = v
	}
	return out
}

var (
	learnedMu sync.RWMutex
	learned   repairState
	// repairMu serialises POST /admin/api/repair/learned: one staging at a time.
	repairMu sync.Mutex
)

func getLearned() repairState {
	learnedMu.RLock()
	defer learnedMu.RUnlock()
	return learned.clone()
}

func setLearned(s repairState) {
	learnedMu.Lock()
	learned = s.clone()
	learnedMu.Unlock()
}

// learnedBL is the bl a repair adopted, "" when none.
func learnedBL() (bl string, at int64) {
	learnedMu.RLock()
	defer learnedMu.RUnlock()
	return learned.BL, learned.At
}

// loadLearned restores the adopted values after a restart. Call after the DB is open.
func loadLearned() {
	raw := kvGet(repairStateKey)
	if raw == "" {
		return
	}
	var s repairState
	if json.Unmarshal([]byte(raw), &s) != nil {
		logf("[repair] ignoring unreadable learned state in kv")
		return
	}
	if s.BL != "" && !blValueRe.MatchString(s.BL) {
		s.BL = ""
	}
	for id, hex := range s.Hex {
		if _, ok := Models[id]; !ok || !modelHexRe.MatchString(hex) {
			delete(s.Hex, id)
		}
	}
	setLearned(s)
}

func persistLearned(s repairState) error {
	b, err := json.Marshal(s)
	if err != nil {
		return err
	}
	return kvSet(repairStateKey, string(b))
}

// dropLearnedBL forgets an adopted bl (the operator pinned a new one).
func dropLearnedBL() {
	s := getLearned()
	if s.BL == "" {
		return
	}
	s.BL = ""
	setLearned(s)
	if err := persistLearned(s); err != nil {
		logf("[repair] persisting the dropped bl failed: %v", err)
	}
	logf("[repair] learned bl dropped: gemini_bl was changed in the panel")
}

// decorateModel finishes a ModelConfig taken from the Models table: it records
// the model id and applies an adopted hex override (modelNeedsLogin keeps
// judging by the catalogued hex, see catalogHex).
func decorateModel(name string, mc ModelConfig) ModelConfig {
	mc.ID = name
	learnedMu.RLock()
	hex := learned.Hex[name]
	learnedMu.RUnlock()
	if hex != "" && hex != mc.HexID {
		mc.catalogHex, mc.HexID = mc.HexID, hex
	}
	return mc
}

// ─── last repair (for /healthz) ──────────────────────────────────────────────

// LastRepair is the outcome of the most recent POST /admin/api/repair/learned.
type LastRepair struct {
	At   int64  `json:"at"` // unix seconds
	Kind string `json:"kind"`
	OK   bool   `json:"ok"` // the staged values passed the canary and were adopted
}

func loadLastRepair() *LastRepair {
	raw := kvGet(lastRepairKey)
	if raw == "" {
		return nil
	}
	var r LastRepair
	if json.Unmarshal([]byte(raw), &r) != nil || r.At == 0 {
		return nil
	}
	return &r
}

func saveLastRepair(r LastRepair) {
	b, _ := json.Marshal(r)
	if err := kvSet(lastRepairKey, string(b)); err != nil {
		logf("[repair] saving last_repair failed: %v", err)
	}
}

// ─── auth ────────────────────────────────────────────────────────────────────

// requireAdminBearer admits only "Authorization: Bearer <admin token>". No
// session cookie, no ?token= (a URL ends up in logs) and no open mode: the
// endpoint behind it hands out account cookies.
func requireAdminBearer(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if cfg.AdminToken == "" {
			writeJSON(w, 403, map[string]string{"error": "this endpoint needs an admin token; none is configured"})
			return
		}
		h := r.Header.Get("Authorization")
		if !strings.HasPrefix(h, "Bearer ") ||
			subtle.ConstantTimeCompare([]byte(strings.TrimSpace(h[7:])), []byte(cfg.AdminToken)) != 1 {
			writeJSON(w, 401, map[string]string{"error": "unauthorized"})
			return
		}
		next(w, r)
	}
}

// ─── GET /admin/api/repair/context ───────────────────────────────────────────

type repairCookie struct {
	Name     string `json:"name"`
	Value    string `json:"value"`
	Domain   string `json:"domain"`
	Path     string `json:"path"`
	Secure   bool   `json:"secure"`
	HTTPOnly bool   `json:"httpOnly"`
}

// healthiestAccount is the enabled account with the fewest consecutive failures,
// then the most recent success. Unlike the request pick it does not touch
// last_used_at: reading a context is not a use of the account.
func healthiestAccount() *CookieAccount {
	var a CookieAccount
	err := getDB().QueryRow(
		`SELECT id, label, cookie, status, note, created_at, last_used_at, last_ok_at, last_error, fail_count, proxy_id
		 FROM accounts WHERE status='enabled' ORDER BY fail_count ASC, last_ok_at DESC, id ASC LIMIT 1`).
		Scan(&a.ID, &a.Label, &a.Cookie, &a.Status, &a.Note,
			&a.CreatedAt, &a.LastUsedAt, &a.LastOkAt, &a.LastError, &a.FailCount, &a.ProxyID)
	if err != nil {
		return nil
	}
	return &a
}

func repairAccountRef(id int64) string { return "acc-" + strconv.FormatInt(id, 10) }

// handleRepairContext serves GET /admin/api/repair/context. The response carries
// cookie values: it is never logged, never cached and reachable with the admin
// token only. The event records the account id and nothing else.
func handleRepairContext(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, 405, map[string]string{"error": "method not allowed"})
		return
	}
	cookies := []repairCookie{}
	var accountID interface{}
	detail := "account=none"
	if a := healthiestAccount(); a != nil {
		for _, kv := range splitCookiePairs(a.Cookie) {
			cookies = append(cookies, repairCookie{
				Name: kv[0], Value: kv[1], Domain: ".google.com", Path: "/", Secure: true, HTTPOnly: true,
			})
		}
		accountID = repairAccountRef(a.ID)
		detail = "account=" + repairAccountRef(a.ID)
	}
	LogEvent(EventRepairContextServed, detail)
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, map[string]interface{}{
		"cookies":       cookies,
		"account_id":    accountID,
		"canary_prompt": repairCanaryPrompt,
		"canary_expect": repairCanaryExpect,
	})
}

// ─── POST /admin/api/repair/learned ──────────────────────────────────────────

var (
	modelHexRe = regexp.MustCompile(`^[0-9a-f]{16}$`)
	// A catalogue id as the page may show it; only a 16-hex one is ever adopted.
	factModelIDRe = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,64}$`)
)

type factModel struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

type pageFacts struct {
	Kind       string      `json:"kind"`
	BL         string      `json:"bl"`
	Models     []factModel `json:"models"`
	SignedIn   *bool       `json:"signed_in"`
	CapturedAt string      `json:"captured_at"`
	AccountID  interface{} `json:"account_id"`
}

// validate checks the shapes. Everything in the report is external input.
func (p *pageFacts) validate() error {
	if p.Kind != repairKindPageFacts {
		return fmt.Errorf("kind must be %q", repairKindPageFacts)
	}
	if p.BL != "" && (len(p.BL) > 120 || !blValueRe.MatchString(p.BL)) {
		return fmt.Errorf("bl does not look like a build label")
	}
	if len(p.Models) > repairMaxModels {
		return fmt.Errorf("at most %d models", repairMaxModels)
	}
	for i, m := range p.Models {
		if !factModelIDRe.MatchString(m.ID) {
			return fmt.Errorf("models[%d].id has an unexpected shape", i)
		}
		if l := strings.TrimSpace(m.Label); l == "" || len(l) > 100 || strings.IndexFunc(l, unicode.IsControl) >= 0 {
			return fmt.Errorf("models[%d].label must be 1-100 printable characters", i)
		}
	}
	if p.SignedIn == nil {
		return fmt.Errorf("signed_in (boolean) is required")
	}
	if _, err := time.Parse(time.RFC3339Nano, p.CapturedAt); err != nil {
		return fmt.Errorf("captured_at must be an RFC 3339 time")
	}
	switch v := p.AccountID.(type) {
	case nil, float64:
	case string:
		if len(v) > 80 {
			return fmt.Errorf("account_id is too long")
		}
	default:
		return fmt.Errorf("account_id must be a string or a number")
	}
	if p.BL == "" && len(p.Models) == 0 {
		return fmt.Errorf("nothing to learn: neither bl nor models")
	}
	return nil
}

// normWebLabel makes picker labels comparable: case, spacing and a leading
// "Gemini" do not matter.
func normWebLabel(s string) string {
	s = strings.ToLower(strings.Join(strings.Fields(s), " "))
	return strings.TrimSpace(strings.TrimPrefix(s, "gemini "))
}

func familyByWebLabel(label string) (modelFamily, bool) {
	want := normWebLabel(label)
	for _, f := range modelFamilies {
		if normWebLabel(f.WebLabel) == want {
			return f, true
		}
	}
	return modelFamily{}, false
}

// modelPlan is what a model catalogue means for our model table.
type modelPlan struct {
	Hex       map[string]string // our model id -> adopted hex (every id of the family)
	Matched   int               // families adopted
	Ambiguous int               // families with conflicting entries: recorded, not adopted
	Unknown   int               // entries whose label names no family (or whose id is no hex)
}

// planModelOverrides adopts only what maps unambiguously: an entry's label must
// name exactly one family, and all entries of that family must agree on one
// 16-hex id that no other family claims.
func planModelOverrides(models []factModel) modelPlan {
	plan := modelPlan{Hex: map[string]string{}}
	byFamily := map[string]map[string]bool{} // family id -> set of hex ids
	for _, m := range models {
		fam, ok := familyByWebLabel(m.Label)
		if !ok || !modelHexRe.MatchString(m.ID) {
			plan.Unknown++
			continue
		}
		if byFamily[fam.ID] == nil {
			byFamily[fam.ID] = map[string]bool{}
		}
		byFamily[fam.ID][m.ID] = true
	}
	owners := map[string]int{} // hex -> number of families claiming it
	for _, ids := range byFamily {
		for id := range ids {
			owners[id]++
		}
	}
	for famID, ids := range byFamily {
		var hex string
		for id := range ids {
			hex = id
		}
		if len(ids) != 1 || owners[hex] != 1 {
			plan.Ambiguous++
			continue
		}
		fam, _, _ := familyOf(famID)
		plan.Matched++
		for _, id := range fam.modelIDs() {
			plan.Hex[id] = hex
		}
	}
	return plan
}

// mergeOverrides applies a plan on top of the current overrides. An id whose new
// hex equals the catalogue value needs no override and is removed.
func mergeOverrides(cur, plan map[string]string) map[string]string {
	out := make(map[string]string, len(cur)+len(plan))
	for k, v := range cur {
		out[k] = v
	}
	for id, hex := range plan {
		if mc, ok := Models[id]; ok && mc.HexID == hex {
			delete(out, id)
			continue
		}
		out[id] = hex
	}
	return out
}

type learnedResponse struct {
	OK        bool   `json:"ok"`
	Validated bool   `json:"validated"`
	EventID   int64  `json:"event_id,omitempty"`
	Error     string `json:"error,omitempty"`
}

// handleRepairLearned serves POST /admin/api/repair/learned.
func handleRepairLearned(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, 405, map[string]string{"error": "method not allowed"})
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, repairMaxBodyBytes))
	var facts pageFacts
	if err == nil {
		err = json.Unmarshal(body, &facts)
	}
	if err != nil {
		writeJSON(w, 400, learnedResponse{Error: "invalid JSON body"})
		return
	}
	if err := facts.validate(); err != nil {
		writeJSON(w, 400, learnedResponse{Error: err.Error()})
		return
	}
	if !repairMu.TryLock() {
		writeJSON(w, 409, learnedResponse{Error: "another repair report is being validated"})
		return
	}
	defer repairMu.Unlock()

	// The job's HTTP client may hang up; the validation must still finish and
	// roll back or adopt, so it does not follow the request context.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), repairCanaryTimeout)
	defer cancel()
	writeJSON(w, 200, stageAndValidate(ctx, facts))
}

// stageAndValidate stages the reported values, runs a direct-path canary with
// them and keeps them only if it passes.
func stageAndValidate(ctx context.Context, facts pageFacts) learnedResponse {
	prev := getLearned()
	next := prev.clone()
	if facts.BL != "" {
		next.BL = facts.BL
	}
	plan := planModelOverrides(facts.Models)
	next.Hex = mergeOverrides(prev.Hex, plan.Hex)
	next.At = time.Now().Unix()

	setLearned(next)
	res, started := runCanary(ctx)
	var failure string
	switch {
	case !started:
		failure = "a canary is already running; retry shortly"
	case res.Skipped:
		failure = "the local IP slots were full, the canary could not run"
	case !res.OK:
		failure = "canary failed: " + res.ErrorClass
	}

	summary := fmt.Sprintf("bl=%s signed_in=%t models=%d adopted=%d ambiguous=%d unknown=%d",
		facts.BL, *facts.SignedIn, len(facts.Models), plan.Matched, plan.Ambiguous, plan.Unknown)
	now := time.Now().Unix()
	if failure != "" {
		setLearned(prev)
		saveLastRepair(LastRepair{At: now, Kind: facts.Kind, OK: false})
		id := logEventID(EventRepairUnvalidated, failure+" ("+summary+"); previous values restored")
		return learnedResponse{OK: true, Validated: false, EventID: id, Error: failure}
	}
	if err := persistLearned(next); err != nil {
		// Adopted in memory and working, but it would not survive a restart.
		logf("[repair] persisting the adopted values failed: %v", err)
	}
	saveLastRepair(LastRepair{At: now, Kind: facts.Kind, OK: true})
	id := logEventID(EventRepairAdopted, fmt.Sprintf("canary ok in %dms (%s)", res.LatencyMs, summary))
	return learnedResponse{OK: true, Validated: true, EventID: id}
}
