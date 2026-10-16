package app

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

const articleSchemaChat = `{"model":"gemini-3.6-flash","messages":[{"role":"user","content":"Summarise the story."}],` +
	`"temperature":0.2,"max_tokens":5,` +
	`"response_format":{"type":"json_schema","json_schema":{"name":"story","strict":true,"schema":` +
	`{"type":"object","properties":{"headline":{"type":"string"},"score":{"type":"integer"}},` +
	`"required":["headline","score"],"additionalProperties":false}}}}`

func TestJSONModeObjectCleansTheAnswer(t *testing.T) {
	withRuntime(t, nil)
	resetBLState(t)
	g := newScriptedGoogle(t, rawText("Sure!\n```json\n{\"a\": 1}\n```\nAnything else?"))

	rec := postJSON(t, handleChatCompletions, "/v1/chat/completions",
		`{"model":"gemini-3.6-flash","messages":[{"role":"user","content":"hi"}],"response_format":{"type":"json_object"}}`)
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	if got := chatContent(t, rec); got != `{"a": 1}` {
		t.Errorf("content = %q, want the bare JSON", got)
	}
	reqs := g.seen()
	if len(reqs) != 1 {
		t.Fatalf("a valid first answer must not trigger a repair: %d calls", len(reqs))
	}
	if !strings.Contains(reqs[0].Prompt, "exactly one JSON object") || !strings.HasPrefix(reqs[0].Prompt, "hi") {
		t.Errorf("format block missing from the prompt:\n%s", reqs[0].Prompt)
	}
}

// One repair round, on the same account, with no time limit other than the
// 600 s ceiling: both Google calls here take longer than request_timeout_sec.
func TestJSONModeRepairReusesAccountAndHasNoTimeLimit(t *testing.T) {
	withRuntime(t, func(c *RuntimeConfig) { c.RequestTimeout = 1 })
	resetBLState(t)
	addTestAccount(t, "json-repair-a")
	addTestAccount(t, "json-repair-b")
	g := newScriptedGoogle(t,
		rawText(`{"headline":"Hello"}`), // score is missing
		rawText(`{"headline":"Hello","score":7}`))
	g.loginPage()
	slow := g.stream
	g.setStream(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(1200 * time.Millisecond)
		slow(w, r)
	})

	rec := postJSON(t, handleChatCompletions, "/v1/chat/completions", articleSchemaChat)
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	if got := chatContent(t, rec); got != `{"headline":"Hello","score":7}` {
		t.Errorf("content = %q", got)
	}
	reqs := g.seen()
	if len(reqs) != 2 {
		t.Fatalf("want exactly one repair round (2 calls), got %d", len(reqs))
	}
	if reqs[0].Cookie == "" || reqs[0].Cookie != reqs[1].Cookie {
		t.Errorf("the repair must reuse the first call's account:\n first:  %q\n repair: %q", reqs[0].Cookie, reqs[1].Cookie)
	}
	repair := reqs[1].Prompt
	for _, want := range []string{`{"headline":"Hello"}`, `missing required property "score"`, "corrected JSON object only", "Summarise the story."} {
		if !strings.Contains(repair, want) {
			t.Errorf("repair prompt lacks %q:\n%s", want, repair)
		}
	}
}

func TestJSONModeStillInvalidIsInvalidJSONError(t *testing.T) {
	withRuntime(t, nil)
	resetBLState(t)
	const secret = "ultra-secret-answer"
	g := newScriptedGoogle(t, rawText(`{"headline":"`+secret+`"}`), rawText(`{"headline":"`+secret+`"}`))

	rec := postJSON(t, handleChatCompletions, "/v1/chat/completions", articleSchemaChat)
	if rec.Code != 503 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	typ, code, msg := errorBody(t, rec)
	if code != "upstream_invalid_json" || typ != "upstream_error" {
		t.Errorf("type=%q code=%q", typ, code)
	}
	if strings.Contains(msg, secret) {
		t.Errorf("the error leaks the model answer: %s", msg)
	}
	if n := len(g.seen()); n != 2 {
		t.Errorf("one repair round only, got %d calls", n)
	}

	// The same failure on the Gemini route: 503 UNAVAILABLE with the class in the details.
	rec = geminiCall(t, "POST", "/v1beta/models/gemini-3.6-flash:generateContent",
		`{"contents":[{"role":"user","parts":[{"text":"x"}]}],"generationConfig":{"responseMimeType":"application/json",`+
			`"responseJsonSchema":{"type":"object","required":["score"]}}}`, nil)
	code2, status, _, reason := geminiErr(t, rec)
	if code2 != 503 || status != "UNAVAILABLE" || reason != "upstream_invalid_json" {
		t.Errorf("gemini route: %d %s %s", code2, status, reason)
	}
}

func TestJSONModeUpstreamErrorIsNotRepaired(t *testing.T) {
	withRuntime(t, nil)
	resetBLState(t)
	g := newFakeGoogle(t)
	g.setStream(func(w http.ResponseWriter, r *http.Request) { writeRaw(w, 429, "") })
	rec := postJSON(t, handleChatCompletions, "/v1/chat/completions", articleSchemaChat)
	if rec.Code != 429 || rec.Header().Get("Retry-After") != "60" {
		t.Fatalf("status %d, Retry-After %q", rec.Code, rec.Header().Get("Retry-After"))
	}
	if hits := g.streamHits.Load(); hits != 1 {
		t.Errorf("a Google failure must not start a repair round: %d calls", hits)
	}
}

// JSON requests are buffered: a streaming client gets the clean JSON in one piece.
func TestJSONModeStreamsTheCleanAnswerAtTheEnd(t *testing.T) {
	withRuntime(t, nil)
	resetBLState(t)
	newScriptedGoogle(t, rawFrames("", "```json\n{\"a\"", "```json\n{\"a\": 1}\n```"))

	rec := postJSON(t, handleChatCompletions, "/v1/chat/completions",
		`{"model":"gemini-3.6-flash","stream":true,"messages":[{"role":"user","content":"hi"}],"response_format":{"type":"json_object"}}`)
	body := rec.Body.String()
	if rec.Code != 200 || strings.Count(body, `"content":"{`) != 1 || !strings.Contains(body, `{\"a\": 1}`) ||
		strings.Contains(body, "```") || !strings.Contains(body, "[DONE]") {
		t.Errorf("stream should carry the clean JSON once:\n%s", body)
	}

	rec = postJSON(t, handleResponses, "/v1/responses",
		`{"model":"gemini-3.6-flash","stream":true,"input":"hi","text":{"format":{"type":"json_object"}}}`)
	body = rec.Body.String()
	if rec.Code != 200 || strings.Count(body, "event: response.output_text.delta") != 1 || strings.Contains(body, "```") ||
		!strings.Contains(body, "response.completed") {
		t.Errorf("responses stream:\n%s", body)
	}

	rec = postJSON(t, handleResponses, "/v1/responses",
		`{"model":"gemini-3.6-flash","input":"hi","text":{"format":{"type":"json_object"}}}`)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"text":"{\"a\": 1}"`) {
		t.Errorf("responses non-stream: %d %s", rec.Code, rec.Body.String())
	}
}

func TestJSONModeRequestValidation(t *testing.T) {
	withRuntime(t, nil)
	resetBLState(t)
	cases := map[string]string{
		"tools":          `{"messages":[{"role":"user","content":"x"}],"tools":[{"type":"function","function":{"name":"f"}}],"response_format":{"type":"json_object"}}`,
		"bad type":       `{"messages":[{"role":"user","content":"x"}],"response_format":{"type":"yaml"}}`,
		"missing schema": `{"messages":[{"role":"user","content":"x"}],"response_format":{"type":"json_schema","json_schema":{"name":"n"}}}`,
	}
	for name, body := range cases {
		rec := postJSON(t, handleChatCompletions, "/v1/chat/completions", body)
		if rec.Code != 400 {
			t.Errorf("%s: status %d: %s", name, rec.Code, rec.Body.String())
		}
	}
}

// Sampling parameters are accepted and ignored (articleSchemaChat carries
// temperature and a tiny max_tokens); the answer is never cut.
func TestSamplingParametersAreIgnored(t *testing.T) {
	withRuntime(t, nil)
	resetBLState(t)
	newScriptedGoogle(t, rawText(strings.Repeat("long ", 400)))
	rec := postJSON(t, handleChatCompletions, "/v1/chat/completions",
		`{"model":"gemini-3.6-flash","temperature":0,"top_p":0.1,"max_tokens":3,"messages":[{"role":"user","content":"hi"}]}`)
	if rec.Code != 200 || len(chatContent(t, rec)) < 1500 {
		t.Errorf("status %d, content length %d", rec.Code, len(chatContent(t, rec)))
	}
}
