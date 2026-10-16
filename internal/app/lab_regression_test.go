package app

// Regression tests for two defects found in an A/B lab (official Gemini API vs.
// this bridge, same prompts): URLs auto-linked by the web app inside answers, and
// JSON-mode answers wrapped in an extra key. The answers below are what the web
// app returned in shape, not literal captures.

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestLabUnwrapAutoLinks(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"same label and target", `[https://example.com/a](https://example.com/a)`, `https://example.com/a`},
		{"in a sentence", `Read [https://example.com/a](https://example.com/a), then stop.`, `Read https://example.com/a, then stop.`},
		{"label without scheme", `[example.com/a](https://example.com/a)`, `example.com/a`},
		{"trailing slash on the label", `[https://example.com/](https://example.com)`, `https://example.com/`},
		{"trailing slash on the target", `[https://example.com/a](https://example.com/a/)`, `https://example.com/a`},
		{"markdown escapes in the label", `[https://example.com/a\_b](https://example.com/a_b)`, `https://example.com/a_b`},
		{"parentheses in the target", `[https://en.wikipedia.org/wiki/Go_(game)](https://en.wikipedia.org/wiki/Go_(game))`, `https://en.wikipedia.org/wiki/Go_(game)`},
		{"angle autolink", `See <https://example.com/a> now`, `See https://example.com/a now`},
		{"two links", `[http://a.io](http://a.io) and [https://b.io/x](https://b.io/x)`, `http://a.io and https://b.io/x`},
		{"real link with another label", `[the report](https://example.com/a)`, `[the report](https://example.com/a)`},
		{"domain label for a deeper page", `[example.com](https://example.com/a/b)`, `[example.com](https://example.com/a/b)`},
		{"image", `![https://example.com/a.png](https://example.com/a.png)`, `![https://example.com/a.png](https://example.com/a.png)`},
		{"link with a title", `[https://example.com/a](https://example.com/a "t")`, `[https://example.com/a](https://example.com/a "t")`},
		{"not a url target", `[foo](foo)`, `[foo](foo)`},
		{"citation brackets", `as shown [1] and arr[0](x)`, `as shown [1] and arr[0](x)`},
		{"angle bracket text", `a <b> c <https://x`, `a <b> c <https://x`},
		{"unclosed", `[https://example.com/a](https://example.com/a`, `[https://example.com/a](https://example.com/a`},
	}
	for _, c := range cases {
		if got := unwrapAutoLinks(c.in); got != c.want {
			t.Errorf("%s: unwrapAutoLinks(%q) = %q, want %q", c.name, c.in, got, c.want)
		}
	}
}

// The prefix diff of a stream must survive a frame that ends inside a link: what
// was sent plus the rest taken from the final text equals the final text.
func TestLabDeltaTrackerHoldsBackUnfinishedLinks(t *testing.T) {
	final := "Source: [https://example.com/a](https://example.com/a) and <https://example.org/b> end"
	want := "Source: https://example.com/a and https://example.org/b end"
	for cut := 1; cut <= len(final); cut++ {
		d := &deltaTracker{}
		var sent string
		for _, frame := range []string{final[:cut/2], final[:cut], final} {
			sent += d.Push(frame)
		}
		if sent != want {
			t.Fatalf("cut %d: sent %q, want %q", cut, sent, want)
		}
	}
	// A frame cut inside a link sends nothing past the text before the link.
	d := &deltaTracker{}
	if got := d.Push("Source: [https://example.com/a](https://exa"); got != "Source: " {
		t.Errorf("held back = %q", got)
	}
	// Ordinary brackets do not hold the stream back once they are resolved.
	d = &deltaTracker{}
	if got := d.Push("see [1] and more"); got != "see [1] and more" {
		t.Errorf("resolved brackets = %q", got)
	}
}

func TestLabFixInvalidJSONEscapes(t *testing.T) {
	cases := []struct{ in, want string }{
		{`{"a": "snake\_case \*bold\* \#1 \- \. \(x\) \[y\]"}`, `{"a": "snake_case *bold* #1 - . (x) [y]"}`},
		{`{"a": "line\nbreak \"q\" \\ \/ \u00e9 \t"}`, `{"a": "line\nbreak \"q\" \\ \/ \u00e9 \t"}`}, // valid escapes stay
		{`{"a_b": 1}`, `{"a_b": 1}`},
		{`{"a": "x"}\_`, `{"a": "x"}\_`}, // outside strings nothing is touched
	}
	for _, c := range cases {
		if got := fixInvalidJSONEscapes(c.in); got != c.want {
			t.Errorf("fixInvalidJSONEscapes(%s) = %s, want %s", c.in, got, c.want)
		}
	}
}

// What the web app returned: the JSON in a fence, a URL auto-linked, markdown
// escapes in a value. One raw wrb.fr frame, every route.
const labWebJSON = "```json\n{\"title\": \"snake\\_case \\*not bold\\*\", " +
	"\"source_url\": \"[https://example.com/a](https://example.com/a)\", " +
	"\"also\": \"<https://example.org/b>\", \"note\": \"[the report](https://example.com/r)\"}\n```"

const labCleanJSON = `{"title": "snake_case *not bold*", "source_url": "https://example.com/a", ` +
	`"also": "https://example.org/b", "note": "[the report](https://example.com/r)"}`

func TestLabRawFrameJSONAnswerIsCleaned(t *testing.T) {
	// the extraction layer on its own: one wrb.fr line
	raw := rawText(labWebJSON)
	got := extractResponseText(raw)
	if strings.Contains(got, "](https://example.com/a)") || strings.Contains(got, "<https://") {
		t.Fatalf("auto-links survived text extraction: %q", got)
	}
	if !strings.Contains(got, "[the report](https://example.com/r)") {
		t.Fatalf("a real link was changed: %q", got)
	}

	withRuntime(t, nil)
	resetBLState(t)
	newScriptedGoogle(t, raw)

	rec := postJSON(t, handleChatCompletions, "/v1/chat/completions",
		`{"model":"gemini-3.6-flash","messages":[{"role":"user","content":"hi"}],"response_format":{"type":"json_object"}}`)
	if rec.Code != 200 {
		t.Fatalf("chat: %d %s", rec.Code, rec.Body.String())
	}
	if c := chatContent(t, rec); c != labCleanJSON {
		t.Errorf("chat json_object content = %s", c)
	}

	rec = postJSON(t, handleChatCompletions, "/v1/chat/completions",
		`{"model":"gemini-3.6-flash","stream":true,"messages":[{"role":"user","content":"hi"}],"response_format":{"type":"json_object"}}`)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `\"source_url\": \"https://example.com/a\"`) ||
		strings.Contains(rec.Body.String(), "](https://example.com/a)") {
		t.Errorf("chat stream: %d %s", rec.Code, rec.Body.String())
	}

	rec = postJSON(t, handleResponses, "/v1/responses",
		`{"model":"gemini-3.6-flash","input":"hi","text":{"format":{"type":"json_object"}}}`)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `snake_case *not bold*`) || strings.Contains(rec.Body.String(), "](https://example.com/a)") {
		t.Errorf("responses: %d %s", rec.Code, rec.Body.String())
	}

	rec = geminiCall(t, "POST", genPath,
		`{"contents":[{"parts":[{"text":"x"}]}],"generationConfig":{"responseMimeType":"application/json"}}`, nil)
	if rec.Code != 200 {
		t.Fatalf("v1beta: %d %s", rec.Code, rec.Body.String())
	}
	if text, _ := candidateText(t, decodeBody(t, rec)); text != labCleanJSON {
		t.Errorf("v1beta text = %s", text)
	}
}

// Plain (non-JSON) answers: self-links are unwrapped, real links stay, streaming
// frames that end inside a link do not corrupt the output.
func TestLabPlainAnswerUnwrapsAutoLinksOnly(t *testing.T) {
	withRuntime(t, nil)
	resetBLState(t)
	final := "Open [https://example.com/a](https://example.com/a) or [docs](https://example.com/docs)."
	want := "Open https://example.com/a or [docs](https://example.com/docs)."
	newScriptedGoogle(t, rawFrames("",
		"Open [https://exam",
		"Open [https://example.com/a](https://example.com/",
		final))

	rec := postJSON(t, handleChatCompletions, "/v1/chat/completions", chatBody)
	if rec.Code != 200 || chatContent(t, rec) != want {
		t.Fatalf("non-stream: %d %s", rec.Code, rec.Body.String())
	}

	rec = postJSON(t, handleChatCompletions, "/v1/chat/completions",
		`{"model":"gemini-3.6-flash","stream":true,"messages":[{"role":"user","content":"hi"}]}`)
	var streamed strings.Builder
	for _, line := range strings.Split(rec.Body.String(), "\n") {
		payload := strings.TrimPrefix(line, "data: ")
		if payload == line || payload == "[DONE]" {
			continue
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if json.Unmarshal([]byte(payload), &chunk) == nil && len(chunk.Choices) > 0 {
			streamed.WriteString(chunk.Choices[0].Delta.Content)
		}
	}
	if rec.Code != 200 || streamed.String() != want {
		t.Errorf("stream: %d content %q, want %q", rec.Code, streamed.String(), want)
	}

	rec = geminiCall(t, "POST", genPath, `{"contents":[{"parts":[{"text":"x"}]}]}`, nil)
	if text, _ := candidateText(t, decodeBody(t, rec)); rec.Code != 200 || text != want {
		t.Errorf("v1beta: %d %q", rec.Code, text)
	}
}

// The browser fallback's text gets the same cleanup, including in JSON mode.
func TestLabBrowserFallbackTextIsCleaned(t *testing.T) {
	b, _ := browserEnv(t)
	b.setAnswer("Source: [https://example.com/a](https://example.com/a)")
	rec := postJSON(t, handleChatCompletions, "/v1/chat/completions", chatBody)
	if rec.Code != 200 || chatContent(t, rec) != "Source: https://example.com/a" {
		t.Fatalf("plain: %d %s", rec.Code, rec.Body.String())
	}
	b.setAnswer(`{"source_url": "[https://example.com/a](https://example.com/a)", "k": "a\_b"}`)
	rec = postJSON(t, handleChatCompletions, "/v1/chat/completions",
		`{"model":"gemini-3.6-flash","messages":[{"role":"user","content":"x"}],"response_format":{"type":"json_object"}}`)
	if rec.Code != 200 || chatContent(t, rec) != `{"source_url": "https://example.com/a", "k": "a_b"}` {
		t.Errorf("json: %d %s", rec.Code, rec.Body.String())
	}
}

// JSON mode, after extraction: a string value that is exactly a self-link is
// unwrapped even where the text-level cleanup could not see it (JSON-escaped
// slashes); a link with another label stays.
func TestLabJSONStringValueSelfLink(t *testing.T) {
	spec := &jsonSpec{Root: jsonRootObject}
	got, p := checkJSONAnswer(`{"u": "[https:\/\/example.com\/a](https:\/\/example.com\/a)", "r": "[x](https://example.com/a)", "n": 3}`, spec)
	if p != nil {
		t.Fatal(p.Error())
	}
	if want := `{"u": "https://example.com/a", "r": "[x](https://example.com/a)", "n": 3}`; got != want {
		t.Errorf("got %s, want %s", got, want)
	}
	// Invalid escapes that cannot be repaired still go to the repair round.
	if _, p := checkJSONAnswer(`{"a": "\q"}`, spec); p == nil {
		t.Error("an unknown letter escape is not a markdown escape and must stay invalid")
	}
}

func TestLabWrapperObjectsWithoutSchema(t *testing.T) {
	inner := `{"headline":"Budget approved","tags":["a"]}`
	for _, key := range wrapperKeys {
		spec := &jsonSpec{Root: jsonRootObject, prompt: "Summarise the story."}
		got, p := checkJSONAnswer("```json\n{\""+key+"\": "+inner+"}\n```", spec)
		if p != nil || got != inner {
			t.Errorf("key %q: got %q, %v", key, got, p)
		}
	}
	keep := []struct{ name, prompt, answer string }{
		{"prompt asks for the key (template)", `Reply as {"result": {"score": 1}}.`, `{"result": {"score": 1}}`},
		{"prompt asks for the key (single quotes)", `The 'data' : object holds the items.`, `{"data": {"x": 1}}`},
		{"prompt lists the key as required", "Required top-level field: \"output\"", `{"output": {"x": 1}}`},
		{"two keys", "Summarise.", `{"result": {"x": 1}, "other": 2}`},
		{"value is not an object", "Summarise.", `{"result": [1, 2]}`},
		{"value is a string", "Summarise.", `{"response": "text"}`},
		{"not a wrapper key", "Summarise.", `{"story": {"x": 1}}`},
	}
	for _, c := range keep {
		got, p := checkJSONAnswer(c.answer, &jsonSpec{Root: jsonRootObject, prompt: c.prompt})
		if p != nil || got != c.answer {
			t.Errorf("%s: got %q, %v; want the answer unchanged", c.name, got, p)
		}
	}
}

// End to end without a schema: the wrapper is removed on json_object and on the
// Gemini mime; the format block names the rule and does not count as the
// request's own text.
func TestLabWrapperObjectEndToEnd(t *testing.T) {
	withRuntime(t, nil)
	resetBLState(t)
	g := newScriptedGoogle(t, rawText("{\"schema\": {\"headline\": \"Hi\", \"n\": 2}}"))

	rec := postJSON(t, handleChatCompletions, "/v1/chat/completions",
		`{"model":"gemini-3.6-flash","messages":[{"role":"user","content":"Summarise."}],"response_format":{"type":"json_object"}}`)
	if rec.Code != 200 || chatContent(t, rec) != `{"headline":"Hi","n":2}` {
		t.Fatalf("chat: %d %s", rec.Code, rec.Body.String())
	}
	if reqs := g.seen(); len(reqs) != 1 {
		t.Errorf("unwrapping must not cost a repair round: %d calls", len(reqs))
	} else if !strings.Contains(reqs[0].Prompt, "do not wrap it in another key") ||
		!strings.Contains(reqs[0].Prompt, "top-level value") {
		t.Errorf("format block lacks the no-wrap rule:\n%s", reqs[0].Prompt)
	}

	rec = geminiCall(t, "POST", genPath,
		`{"contents":[{"parts":[{"text":"x"}]}],"generationConfig":{"responseMimeType":"application/json"}}`, nil)
	if text, _ := candidateText(t, decodeBody(t, rec)); rec.Code != 200 || text != `{"headline":"Hi","n":2}` {
		t.Errorf("v1beta: %d %q", rec.Code, text)
	}

	// The prompt names "schema" as a field: the wrapper is the requested shape.
	newScriptedGoogle(t, rawText("{\"schema\": {\"a\": 1}}"))
	rec = postJSON(t, handleChatCompletions, "/v1/chat/completions",
		`{"model":"gemini-3.6-flash","messages":[{"role":"user","content":"Reply as {\"schema\": {...}}"}],"response_format":{"type":"json_object"}}`)
	if rec.Code != 200 || chatContent(t, rec) != `{"schema": {"a": 1}}` {
		t.Errorf("requested wrapper: %d %s", rec.Code, rec.Body.String())
	}
}

// With a schema the wrapper is not removed: validation fails and the repair round
// tells the model not to wrap.
func TestLabWrapperObjectWithSchemaIsRepaired(t *testing.T) {
	withRuntime(t, nil)
	resetBLState(t)
	g := newScriptedGoogle(t,
		rawText(`{"schema": {"headline": "Hello", "score": 7}}`),
		rawText(`{"headline": "Hello", "score": 7}`))

	rec := postJSON(t, handleChatCompletions, "/v1/chat/completions", articleSchemaChat)
	if rec.Code != 200 || chatContent(t, rec) != `{"headline": "Hello", "score": 7}` {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	reqs := g.seen()
	if len(reqs) != 2 {
		t.Fatalf("want one repair round, got %d calls", len(reqs))
	}
	if !strings.Contains(reqs[1].Prompt, "do not wrap it in another key") || !strings.Contains(reqs[1].Prompt, `"schema"`) {
		t.Errorf("repair message must say not to wrap:\n%s", reqs[1].Prompt)
	}
}

func TestLabInstructionsTellNotToWrap(t *testing.T) {
	obj := (&jsonSpec{Root: jsonRootObject}).instruction()
	arr := (&jsonSpec{Root: jsonRootArray}).instruction()
	for _, s := range []string{obj, arr} {
		for _, want := range []string{"do not wrap it in another key", `"schema"`, `"json"`, `"response"`, "plain text", "No markdown code fences"} {
			if !strings.Contains(s, want) {
				t.Errorf("instruction lacks %q:\n%s", want, s)
			}
		}
	}
	if !strings.Contains(arr, "The array itself") || !strings.Contains(obj, "The object itself") {
		t.Errorf("root noun: %s | %s", obj, arr)
	}
	rep := (&jsonSpec{Root: jsonRootObject}).repairInstruction(problem("$.x", "required"))
	if !strings.Contains(rep, "do not wrap it") {
		t.Errorf("repair instruction: %s", rep)
	}
}

// The newsroom normalizer sends {"schema": {...}, "input": ...}; the web model
// answered {"schema": {...filled...}} (VPS lab, 17 Oct 2026). The prompt names
// "schema", but only as its own envelope, so the echo is unwrapped.
func TestUnwrapEchoedPromptContainer(t *testing.T) {
	prompt := `User request:
{"schema":{"source":{},"story":{},"evidence":[],"selection":{},"owner_policy":{},"routing":{}},"input":{"title":"x"}}`
	answer := `{"schema":{"source":{"a":1},"story":{"b":2},"evidence":[],"selection":{},"owner_policy":{},"routing":{}}}`
	got, ok := unwrapWrapper(answer, prompt)
	if !ok || !strings.HasPrefix(got, `{"source":`) {
		t.Fatalf("echoed container must be unwrapped: ok=%v %s", ok, got)
	}
	// A prompt that asks for a "schema" output field keeps the answer as it is.
	asks := `Return JSON with a required field "schema": an object describing the table.`
	if _, ok := unwrapWrapper(`{"schema":{"columns":[],"name":"t","rows":3}}`, asks); ok {
		t.Fatal("a requested schema field must not be unwrapped")
	}
	// Few shared fields with the prompt's container: not an echo.
	other := `{"schema":{"x":1,"y":2,"z":3}}`
	if _, ok := unwrapWrapper(other, prompt); ok {
		t.Fatal("an object that does not echo the prompt container must stay wrapped")
	}
}
