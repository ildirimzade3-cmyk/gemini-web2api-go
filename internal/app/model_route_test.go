package app

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

// The mapping documented in model_route.go, as a table.
func TestRouteModelTable(t *testing.T) {
	withPoolCookie(t) // the thinking variants need a signed-in account
	cases := []struct {
		in       string
		thinking bool
		want     string
	}{
		{"gemini-3.8-flash", false, "gemini-3.8-flash"},
		{"models/gemini-3.8-flash", false, "gemini-3.8-flash"},
		{"gemini-3.8-flash", true, "gemini-3.8-flash-thinking"},
		{"models/gemini-3.6-flash", true, "gemini-3.6-flash-thinking"},
		{"gemini-3.5-flash-lite", true, "gemini-3.5-flash-lite-thinking"},
		{"gemini-3.1-pro", true, "gemini-3.1-pro-thinking"},
		{"gemini-4-argon", true, "gemini-4-argon-thinking"},
		{"gemini-3.7-flash", false, "gemini-3.7-flash"},
		{"gemini-3.7-flash", true, "gemini-3.7-flash-thinking"},
		// a request that already names a thinking model keeps it, whatever the settings say
		{"gemini-3.6-flash-thinking", false, "gemini-3.6-flash-thinking"},
		{"gemini-3.6-flash-thinking", true, "gemini-3.6-flash-thinking"},
		{"models/gemini-4-argon-thinking", false, "gemini-4-argon-thinking"},
		{"gemini-3.6-flash@think=2", false, "gemini-3.6-flash"},
		// media models are not families: reachable by name, untouched by thinking
		{"gemini-image", true, "gemini-image"},
	}
	for _, c := range cases {
		got, mc, err := routeModel(c.in, c.thinking)
		if err != nil || got != c.want {
			t.Errorf("routeModel(%q, %v) = %q, %v; want %q", c.in, c.thinking, got, err, c.want)
			continue
		}
		if strings.HasSuffix(c.want, thinkingSuffix) != mc.Thinking {
			t.Errorf("%s: Thinking flag = %v", c.want, mc.Thinking)
		}
	}
	if _, _, err := routeModel("gpt-4o", false); err == nil {
		t.Error("unknown model must fail")
	} else if _, ok := err.(*unknownModelError); !ok {
		t.Errorf("unknown model error type %T", err)
	}
	// The Gemini routes serve the families only.
	if _, _, err := routeFamilyModel("gemini-image", false); err == nil {
		t.Error("gemini-image is not a /v1beta model")
	}
	if _, _, err := routeFamilyModel("models/gemini-3.6-flash", true); err != nil {
		t.Errorf("family model on the gemini route: %v", err)
	}
}

func TestThinkingSettings(t *testing.T) {
	f := func(v float64) *float64 { return &v }
	cases := []struct {
		level  string
		budget *float64
		want   bool
	}{
		{"HIGH", nil, true}, {"MEDIUM", nil, true}, {"high", nil, true},
		{"LOW", nil, false}, {"MINIMAL", nil, false}, {"", nil, false},
		{"", f(1024), true}, {"", f(1), true}, {"", f(0), false}, {"", f(-1), false},
		{"LOW", f(8000), false}, // the level wins over the budget
		{"HIGH", f(0), true},
	}
	for _, c := range cases {
		if got := thinkingFromGemini(c.level, c.budget); got != c.want {
			t.Errorf("thinkingFromGemini(%q, %v) = %v, want %v", c.level, c.budget, got, c.want)
		}
	}
	for effort, want := range map[string]bool{"high": true, "medium": true, "HIGH": true,
		"low": false, "minimal": false, "none": false, "": false, "bogus": false} {
		if got := thinkingFromEffort(effort); got != want {
			t.Errorf("thinkingFromEffort(%q) = %v, want %v", effort, got, want)
		}
	}
}

// Every family has its thinking sibling in Models, so the suffix rule is sound.
func TestModelFamiliesMatchModels(t *testing.T) {
	for _, f := range modelFamilies {
		for _, id := range append([]string{f.ID}, f.Aliases...) {
			plain, ok := Models[id]
			if !ok || plain.Thinking {
				t.Errorf("%s: missing or already thinking", id)
			}
			think, ok := Models[id+thinkingSuffix]
			if !ok || !think.Thinking || think.HexID != plain.HexID || think.Mode != plain.Mode {
				t.Errorf("%s: thinking sibling is wrong: %+v", id, think)
			}
		}
	}
}

func TestReasoningEffortSelectsThinkingOnTheOpenAIRoutes(t *testing.T) {
	withRuntime(t, nil)
	resetBLState(t)
	addTestAccount(t, "effort-acct")
	g := newScriptedGoogle(t, rawText("ok"))
	g.loginPage()

	for _, c := range []struct {
		name, body string
		wantThink  float64
	}{
		{"chat high", `{"model":"gemini-3.6-flash","reasoning_effort":"high","messages":[{"role":"user","content":"hi"}]}`, 2},
		{"chat low", `{"model":"gemini-3.6-flash","reasoning_effort":"low","messages":[{"role":"user","content":"hi"}]}`, 1},
		{"chat none", `{"model":"gemini-3.6-flash","messages":[{"role":"user","content":"hi"}]}`, 1},
		{"chat named", `{"model":"gemini-3.6-flash-thinking","reasoning_effort":"low","messages":[{"role":"user","content":"hi"}]}`, 2},
	} {
		before := len(g.seen())
		rec := postJSON(t, handleChatCompletions, "/v1/chat/completions", c.body)
		if rec.Code != 200 {
			t.Fatalf("%s: %d %s", c.name, rec.Code, rec.Body.String())
		}
		reqs := g.seen()
		if len(reqs) != before+1 || reqs[before].Think != c.wantThink {
			t.Errorf("%s: inner[80] = %v, want %v", c.name, reqs[before].Think, c.wantThink)
		}
	}
	before := len(g.seen())
	rec := postJSON(t, handleResponses, "/v1/responses", `{"model":"gemini-3.8-flash","input":"hi","reasoning":{"effort":"medium"}}`)
	if rec.Code != 200 {
		t.Fatalf("responses: %d %s", rec.Code, rec.Body.String())
	}
	if reqs := g.seen(); reqs[before].Think != float64(2) {
		t.Errorf("responses medium effort: inner[80] = %v", reqs[before].Think)
	}
}

func TestV1ModelsExposeTheThinkingMapping(t *testing.T) {
	withPoolCookie(t)
	rec := httptest.NewRecorder()
	handleModels(rec, httptest.NewRequest("GET", "/v1/models", nil))
	var body struct {
		Data []map[string]interface{} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	byID := map[string]map[string]interface{}{}
	for _, m := range body.Data {
		byID[m["id"].(string)] = m
	}
	if byID["gemini-3.6-flash"]["thinking"] != false || byID["gemini-3.6-flash"]["thinking_variant"] != "gemini-3.6-flash-thinking" {
		t.Errorf("plain entry: %v", byID["gemini-3.6-flash"])
	}
	if byID["gemini-3.6-flash-thinking"]["thinking"] != true || byID["gemini-3.6-flash-thinking"]["base_model"] != "gemini-3.6-flash" {
		t.Errorf("thinking entry: %v", byID["gemini-3.6-flash-thinking"])
	}
	if _, has := byID["gemini-image"]["thinking_variant"]; has {
		t.Error("media models have no thinking variant")
	}
}
