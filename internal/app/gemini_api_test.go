package app

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

const genPath = "/v1beta/models/gemini-3.6-flash:generateContent"

const simpleGen = `{"contents":[{"role":"user","parts":[{"text":"Say hi"}]}]}`

func TestGeminiAuth(t *testing.T) {
	withRuntime(t, nil)
	withAPIKey(t, "sk-gemini-test-key-0123456789")
	for _, c := range []struct {
		name    string
		target  string
		headers map[string]string
		code    int
		status  string
	}{
		{"missing", "/v1beta/models", nil, 401, "UNAUTHENTICATED"},
		{"wrong header", "/v1beta/models", map[string]string{"x-goog-api-key": "nope"}, 403, "PERMISSION_DENIED"},
		{"wrong query", "/v1beta/models?key=nope", nil, 403, "PERMISSION_DENIED"},
		{"header", "/v1beta/models", map[string]string{"x-goog-api-key": "sk-gemini-test-key-0123456789"}, 200, ""},
		{"query", "/v1beta/models?key=sk-gemini-test-key-0123456789", nil, 200, ""},
		{"bearer", "/v1beta/models", map[string]string{"Authorization": "Bearer sk-gemini-test-key-0123456789"}, 200, ""},
	} {
		rec := geminiCall(t, "GET", c.target, "", c.headers)
		if rec.Code != c.code {
			t.Errorf("%s: status %d, want %d (%s)", c.name, rec.Code, c.code, rec.Body.String())
			continue
		}
		if c.status != "" {
			if code, status, _, _ := geminiErr(t, rec); code != c.code || status != c.status {
				t.Errorf("%s: error body %d %s", c.name, code, status)
			}
		}
	}
	if rec := geminiCall(t, "OPTIONS", "/v1beta/models", "", nil); rec.Code != 204 {
		t.Errorf("CORS preflight needs no key: %d", rec.Code)
	}
}

func modelNames(t *testing.T, body []byte) map[string]map[string]interface{} {
	t.Helper()
	var parsed struct {
		Models []map[string]interface{} `json:"models"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		t.Fatal(err)
	}
	names := map[string]map[string]interface{}{}
	for _, m := range parsed.Models {
		names[m["name"].(string)] = m
	}
	return names
}

func TestGeminiListAndGet(t *testing.T) {
	if hasCookie() {
		t.Skip("cookie pool is not empty")
	}
	// Anonymous: the thinking variants and login-only models are not offered.
	rec := geminiCall(t, "GET", "/v1beta/models", "", nil)
	if rec.Code != 200 {
		t.Fatalf("list: %d %s", rec.Code, rec.Body.String())
	}
	names := modelNames(t, rec.Body.Bytes())
	if len(names) != 2 || names["models/gemini-3.6-flash"] == nil || names["models/gemini-3.5-flash-lite"] == nil {
		t.Errorf("anonymous list: %v", names)
	}

	addTestAccount(t, "list-acct")
	rec = geminiCall(t, "GET", "/v1beta/models", "", nil)
	names = modelNames(t, rec.Body.Bytes())
	plain, think := names["models/gemini-3.6-flash"], names["models/gemini-3.6-flash-thinking"]
	if plain == nil || think == nil {
		t.Fatalf("signed-in list lacks the thinking variant: %v", names)
	}
	if plain["thinking"] != false || think["thinking"] != true || think["baseModelId"] != "gemini-3.6-flash" {
		t.Errorf("thinking flags: %v / %v", plain, think)
	}
	for _, f := range []string{"displayName", "inputTokenLimit", "outputTokenLimit", "supportedGenerationMethods"} {
		if plain[f] == nil {
			t.Errorf("list entry lacks %s", f)
		}
	}
	methods := plain["supportedGenerationMethods"].([]interface{})
	if len(methods) != 2 || methods[0] != "generateContent" || methods[1] != "streamGenerateContent" {
		t.Errorf("methods: %v", methods)
	}
	if names["models/gemini-3.7-flash"] != nil {
		t.Error("aliases are accepted but not listed")
	}

	// Get one: canonical, alias, thinking, unknown.
	for target, want := range map[string]int{
		"/v1beta/models/gemini-3.8-flash":             200,
		"/v1beta/models/gemini-3.7-flash":             200,
		"/v1beta/models/gemini-4-argon-thinking":      200,
		"/v1beta/models/gemini-image":                 404,
		"/v1beta/models/definitely-not-a-model":       404,
		"/v1beta/models/gemini-3.6-flash:countTokens": 405, // GET on a method path
	} {
		if rec := geminiCall(t, "GET", target, "", nil); rec.Code != want {
			t.Errorf("GET %s: %d, want %d: %s", target, rec.Code, want, rec.Body.String())
		}
	}
	rec = geminiCall(t, "GET", "/v1beta/models/gemini-3.7-flash", "", nil)
	if got := decodeBody(t, rec)["name"]; got != "models/gemini-3.7-flash" {
		t.Errorf("alias keeps its own name, got %v", got)
	}
}

func TestGeminiGenerateContentShape(t *testing.T) {
	withRuntime(t, nil)
	resetBLState(t)
	g := newScriptedGoogle(t, rawText("Hello there"))

	rec := geminiCall(t, "POST", genPath, `{
		"systemInstruction":{"parts":[{"text":"Be brief."}]},
		"contents":[
			{"role":"user","parts":[{"text":"first question"}]},
			{"role":"model","parts":[{"text":"first answer"}]},
			{"role":"user","parts":[{"text":"Say hi"}]}],
		"generationConfig":{"temperature":0.1,"maxOutputTokens":2,"topP":0.5,"stopSequences":["x"]}}`, nil)
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	resp := decodeBody(t, rec)
	if text, thought := candidateText(t, resp); text != "Hello there" || thought != "" {
		t.Errorf("text=%q thought=%q", text, thought)
	}
	cand := resp["candidates"].([]interface{})[0].(map[string]interface{})
	if cand["finishReason"] != "STOP" || cand["index"] != float64(0) ||
		cand["content"].(map[string]interface{})["role"] != "model" {
		t.Errorf("candidate: %v", cand)
	}
	usage := resp["usageMetadata"].(map[string]interface{})
	for _, k := range []string{"promptTokenCount", "candidatesTokenCount", "totalTokenCount"} {
		if _, ok := usage[k]; !ok {
			t.Errorf("usageMetadata lacks %s: %v", k, usage)
		}
	}
	if resp["modelVersion"] != "gemini-3.6-flash" {
		t.Errorf("modelVersion = %v", resp["modelVersion"])
	}
	prompt := g.seen()[0].Prompt
	for _, want := range []string{"[System instruction]: Be brief.", "first question", "[Assistant]: first answer", "Say hi"} {
		if !strings.Contains(prompt, want) {
			t.Errorf("prompt lacks %q:\n%s", want, prompt)
		}
	}
	// the "models/" prefix on the path is accepted
	if rec := geminiCall(t, "POST", "/v1beta/models/models/gemini-3.6-flash:generateContent", simpleGen, nil); rec.Code != 200 {
		t.Errorf("models/ prefix: %d %s", rec.Code, rec.Body.String())
	}
}

func TestGeminiThinkingConfigSelectsTheVariant(t *testing.T) {
	withRuntime(t, nil)
	resetBLState(t)
	addTestAccount(t, "think-acct")
	g := newScriptedGoogle(t, rawFrames("pondering the question", "Answer"))
	g.loginPage()

	gen := func(cfg string) map[string]interface{} {
		t.Helper()
		body := `{"contents":[{"role":"user","parts":[{"text":"q"}]}],"generationConfig":{"thinkingConfig":` + cfg + `}}`
		rec := geminiCall(t, "POST", genPath, body, nil)
		if rec.Code != 200 {
			t.Fatalf("%s: %d %s", cfg, rec.Code, rec.Body.String())
		}
		return decodeBody(t, rec)
	}
	for _, c := range []struct {
		cfg  string
		want float64
		ver  string
	}{
		{`{"thinkingLevel":"HIGH"}`, 2, "gemini-3.6-flash-thinking"},
		{`{"thinkingLevel":"MEDIUM"}`, 2, "gemini-3.6-flash-thinking"},
		{`{"thinkingBudget":2048}`, 2, "gemini-3.6-flash-thinking"},
		{`{"thinkingLevel":"LOW"}`, 1, "gemini-3.6-flash"},
		{`{"thinkingLevel":"MINIMAL"}`, 1, "gemini-3.6-flash"},
		{`{"thinkingBudget":0}`, 1, "gemini-3.6-flash"},
		{`{}`, 1, "gemini-3.6-flash"},
	} {
		before := len(g.seen())
		resp := gen(c.cfg)
		if got := g.seen()[before].Think; got != c.want {
			t.Errorf("%s: inner[80] = %v, want %v", c.cfg, got, c.want)
		}
		if resp["modelVersion"] != c.ver {
			t.Errorf("%s: modelVersion = %v, want %s", c.cfg, resp["modelVersion"], c.ver)
		}
	}

	// includeThoughts adds a thought part; without it the thoughts are hidden but still counted.
	resp := gen(`{"thinkingLevel":"HIGH","includeThoughts":true}`)
	if text, thought := candidateText(t, resp); text != "Answer" || thought != "pondering the question" {
		t.Errorf("includeThoughts: text=%q thought=%q", text, thought)
	}
	resp = gen(`{"thinkingLevel":"HIGH"}`)
	if text, thought := candidateText(t, resp); text != "Answer" || thought != "" {
		t.Errorf("hidden thoughts: text=%q thought=%q", text, thought)
	}
	if resp["usageMetadata"].(map[string]interface{})["thoughtsTokenCount"] == nil {
		t.Errorf("thoughtsTokenCount missing: %v", resp["usageMetadata"])
	}
}

func TestGeminiStreamSSE(t *testing.T) {
	withRuntime(t, nil)
	resetBLState(t)
	newScriptedGoogle(t, rawFrames("", "Hel", "Hello", "Hello wor", "Hello world"))

	rec := geminiCall(t, "POST", "/v1beta/models/gemini-3.6-flash:streamGenerateContent?alt=sse", simpleGen, nil)
	if rec.Code != 200 || !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/event-stream") {
		t.Fatalf("status %d, content type %q", rec.Code, rec.Header().Get("Content-Type"))
	}
	var frames []map[string]interface{}
	for _, block := range strings.Split(strings.TrimSpace(rec.Body.String()), "\n\n") {
		if !strings.HasPrefix(block, "data: ") {
			t.Fatalf("not an SSE data frame: %q", block)
		}
		var f map[string]interface{}
		if err := json.Unmarshal([]byte(strings.TrimPrefix(block, "data: ")), &f); err != nil {
			t.Fatalf("frame is not JSON: %v: %q", err, block)
		}
		frames = append(frames, f)
	}
	if len(frames) < 2 {
		t.Fatalf("want several frames, got %d", len(frames))
	}
	var all strings.Builder
	for i, f := range frames {
		text, _ := candidateText(t, f)
		all.WriteString(text)
		cand := f["candidates"].([]interface{})[0].(map[string]interface{})
		last := i == len(frames)-1
		if (cand["finishReason"] == "STOP") != last || (f["usageMetadata"] != nil) != last {
			t.Errorf("frame %d: finishReason/usage only belong on the last frame: %v", i, f)
		}
	}
	if all.String() != "Hello world" {
		t.Errorf("concatenated text = %q", all.String())
	}
}

func TestGeminiStreamJSONArray(t *testing.T) {
	withRuntime(t, nil)
	resetBLState(t)
	newScriptedGoogle(t, rawFrames("", "Hello", "Hello world"))

	rec := geminiCall(t, "POST", "/v1beta/models/gemini-3.6-flash:streamGenerateContent", simpleGen, nil)
	if rec.Code != 200 || !strings.HasPrefix(rec.Header().Get("Content-Type"), "application/json") {
		t.Fatalf("status %d, content type %q", rec.Code, rec.Header().Get("Content-Type"))
	}
	var frames []map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &frames); err != nil {
		t.Fatalf("body is not a JSON array: %v\n%s", err, rec.Body.String())
	}
	var all strings.Builder
	for _, f := range frames {
		text, _ := candidateText(t, f)
		all.WriteString(text)
	}
	if len(frames) < 2 || all.String() != "Hello world" {
		t.Errorf("%d frames, text %q", len(frames), all.String())
	}
}

func TestGeminiErrorShapes(t *testing.T) {
	withRuntime(t, nil)
	resetBLState(t)
	g := newFakeGoogle(t)

	type want struct {
		code       int
		status     string
		reason     string
		retryAfter string
	}
	upstream := map[string]struct {
		h http.HandlerFunc
		w want
	}{
		"429": {func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Retry-After", "17")
			writeRaw(w, 429, "")
		}, want{429, "RESOURCE_EXHAUSTED", "upstream_rate_limited", "17"}},
		"500": {func(w http.ResponseWriter, r *http.Request) { writeRaw(w, 500, "") },
			want{503, "UNAVAILABLE", "upstream_unavailable", ""}},
		"protocol": {func(w http.ResponseWriter, r *http.Request) { writeRaw(w, 200, "<html>x</html>") },
			want{503, "UNAVAILABLE", "upstream_protocol_changed", ""}},
	}
	for name, c := range upstream {
		for _, target := range []string{genPath, "/v1beta/models/gemini-3.6-flash:streamGenerateContent",
			"/v1beta/models/gemini-3.6-flash:streamGenerateContent?alt=sse"} {
			g.setStream(c.h)
			rec := geminiCall(t, "POST", target, simpleGen, nil)
			code, status, msg, reason := geminiErr(t, rec)
			if rec.Code != c.w.code || code != c.w.code || status != c.w.status || reason != c.w.reason || msg == "" {
				t.Errorf("%s %s: %d %d %s %s", name, target, rec.Code, code, status, reason)
			}
			if got := rec.Header().Get("Retry-After"); got != c.w.retryAfter {
				t.Errorf("%s: Retry-After %q, want %q", name, got, c.w.retryAfter)
			}
		}
	}
}

func TestGeminiRequestRejections(t *testing.T) {
	withRuntime(t, nil)
	resetBLState(t)
	if hasCookie() {
		t.Skip("cookie pool is not empty")
	}
	cases := []struct {
		name, target, body string
		code               int
		status             string
	}{
		{"unknown model", "/v1beta/models/nope:generateContent", simpleGen, 404, "NOT_FOUND"},
		{"media model", "/v1beta/models/gemini-image:generateContent", simpleGen, 404, "NOT_FOUND"},
		{"bad json", genPath, `{`, 400, "INVALID_ARGUMENT"},
		{"no contents", genPath, `{}`, 400, "INVALID_ARGUMENT"},
		{"tools", genPath, `{"contents":[{"parts":[{"text":"x"}]}],"tools":[{"functionDeclarations":[{"name":"f"}]}]}`, 400, "INVALID_ARGUMENT"},
		{"function call part", genPath, `{"contents":[{"role":"model","parts":[{"functionCall":{"name":"f"}}]}]}`, 400, "INVALID_ARGUMENT"},
		{"bad role", genPath, `{"contents":[{"role":"robot","parts":[{"text":"x"}]}]}`, 400, "INVALID_ARGUMENT"},
		{"empty part", genPath, `{"contents":[{"parts":[{}]}]}`, 400, "INVALID_ARGUMENT"},
		{"candidateCount", genPath, `{"contents":[{"parts":[{"text":"x"}]}],"generationConfig":{"candidateCount":2}}`, 400, "INVALID_ARGUMENT"},
		{"mime type", genPath, `{"contents":[{"parts":[{"text":"x"}]}],"generationConfig":{"responseMimeType":"text/x.enum"}}`, 400, "INVALID_ARGUMENT"},
		{"unknown method", "/v1beta/models/gemini-3.6-flash:countTokens", simpleGen, 404, "NOT_FOUND"},
		{"fileData gs uri", genPath, `{"contents":[{"parts":[{"fileData":{"mimeType":"application/pdf","fileUri":"gs://bucket/a.pdf"}}]}]}`, 503, "UNAVAILABLE"},
		// Without an account every attachment is refused up front (503 no_valid_account).
		{"inlineData without account", genPath, `{"contents":[{"parts":[{"inlineData":{"mimeType":"application/pdf","data":"JVBERi0="}}]}]}`, 503, "UNAVAILABLE"},
	}
	for _, c := range cases {
		rec := geminiCall(t, "POST", c.target, c.body, nil)
		code, status, _, _ := geminiErr(t, rec)
		if rec.Code != c.code || code != c.code || status != c.status {
			t.Errorf("%s: %d %d %s, want %d %s: %s", c.name, rec.Code, code, status, c.code, c.status, rec.Body.String())
		}
	}
	if rec := geminiCall(t, "GET", genPath, "", nil); rec.Code != 405 {
		t.Errorf("GET on a POST method: %d", rec.Code)
	}
}

func TestGeminiJSONMimeEnforcesAndRepairs(t *testing.T) {
	withRuntime(t, nil)
	resetBLState(t)
	g := newScriptedGoogle(t,
		rawText("```json\n{\"headline\": 42}\n```"), // wrong type
		rawText("```json\n{\"headline\": \"ok\", \"tags\": [\"a\"]}\n```"))

	// responseSchema in Gemini's OpenAPI form (upper-case types).
	body := `{"contents":[{"role":"user","parts":[{"text":"story"}]}],"generationConfig":{
		"responseMimeType":"application/json",
		"responseSchema":{"type":"OBJECT","properties":{"headline":{"type":"STRING"},"tags":{"type":"ARRAY","items":{"type":"STRING"}}},"required":["headline"]}}}`
	rec := geminiCall(t, "POST", genPath, body, nil)
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	text, _ := candidateText(t, decodeBody(t, rec))
	if text != `{"headline": "ok", "tags": ["a"]}` {
		t.Errorf("text = %q", text)
	}
	reqs := g.seen()
	if len(reqs) != 2 || !strings.Contains(reqs[1].Prompt, "$.headline: expected string, got number") {
		t.Errorf("repair round: %d calls\n%v", len(reqs), reqs)
	}
	if !strings.Contains(reqs[0].Prompt, `"type":"object"`) {
		t.Errorf("the schema should be shown to the model in plain JSON Schema form:\n%s", reqs[0].Prompt)
	}

	// JSON mime without a schema: any JSON value, streamed as one frame at the end.
	rec = geminiCall(t, "POST", "/v1beta/models/gemini-3.6-flash:streamGenerateContent?alt=sse",
		`{"contents":[{"parts":[{"text":"x"}]}],"generationConfig":{"responseMimeType":"application/json"}}`, nil)
	if rec.Code != 200 || strings.Count(rec.Body.String(), "data: ") != 1 || strings.Contains(rec.Body.String(), "```") {
		t.Errorf("json stream: %d %s", rec.Code, rec.Body.String())
	}
}
