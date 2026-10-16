package app

import (
	"strings"
	"testing"
)

// A prompt over max_prompt_bytes goes to Google as the attachment message.txt
// plus a short instruction, on the /v1beta route as well as on the OpenAI routes.
func TestLongPromptBecomesContextFileOnTheGeminiRoute(t *testing.T) {
	withRuntime(t, func(c *RuntimeConfig) { c.MaxPromptBytes = 2000 })
	resetBLState(t)
	addTestAccount(t, "ctxfile-acct")
	up := newFakeUpload(t)
	g := newScriptedGoogle(t, rawText("read it"))
	g.loginPage()

	long := strings.Repeat("The quick brown fox jumps over the lazy dog. ", 200) // ~9 KB
	rec := geminiCall(t, "POST", genPath,
		`{"contents":[{"role":"user","parts":[{"text":"`+long+`"}]},{"role":"model","parts":[{"text":"ok"}]},`+
			`{"role":"user","parts":[{"text":"What colour is the fox?"}]}]}`, nil)
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	if text, _ := candidateText(t, decodeBody(t, rec)); text != "read it" {
		t.Errorf("text = %q", text)
	}
	reqs := g.seen()
	if len(reqs) != 1 {
		t.Fatalf("%d calls", len(reqs))
	}
	if len(reqs[0].Prompt) > 600 {
		t.Errorf("the request prompt should be the short instruction, got %d bytes", len(reqs[0].Prompt))
	}
	for _, want := range []string{"attached `message.txt`", "What colour is the fox?"} {
		if !strings.Contains(reqs[0].Prompt, want) {
			t.Errorf("prompt lacks %q:\n%s", want, reqs[0].Prompt)
		}
	}
	if len(reqs[0].Refs) != 1 {
		t.Fatalf("want the context file as the only attachment, got %d", len(reqs[0].Refs))
	}
	if k, m, n := refTuple(t, reqs[0].Refs[0]); k != 3 || m != "text/plain" || n != "message.txt" {
		t.Errorf("context file ref = %v %s %s", k, m, n)
	}
	if names := up.names(); len(names) != 1 || names[0] != "message.txt" {
		t.Errorf("uploads: %v", names)
	}
	if len(up.Sizes) != 1 || up.Sizes[0] < len(long) {
		t.Errorf("the uploaded text should hold the whole conversation: %v", up.Sizes)
	}
}

// The JSON repair round carries the invalid answer back; when that makes the
// prompt too long it goes through the same context-file path, on the same account.
func TestJSONRepairRoundUsesTheContextFileToo(t *testing.T) {
	withRuntime(t, func(c *RuntimeConfig) { c.MaxPromptBytes = 3000 })
	resetBLState(t)
	addTestAccount(t, "ctxfile-json-a")
	addTestAccount(t, "ctxfile-json-b")
	up := newFakeUpload(t)
	invalid := `{"headline":"` + strings.Repeat("x", 1500) + `"}` // valid JSON, but "score" is missing
	g := newScriptedGoogle(t, rawText(invalid), rawText(`{"headline":"h","score":3}`))
	g.loginPage()

	// ~3.6 KB of article text: over the budget once the format block is added,
	// and certainly over it once the 1.5 KB invalid answer is appended for the repair.
	article := strings.Repeat("Parliament approved the budget after a long debate. ", 70)
	rec := postJSON(t, handleChatCompletions, "/v1/chat/completions", `{"model":"gemini-3.6-flash",`+
		`"messages":[{"role":"user","content":"`+article+`"}],`+
		`"response_format":{"type":"json_schema","json_schema":{"name":"s","schema":{"type":"object",`+
		`"properties":{"headline":{"type":"string"},"score":{"type":"integer"}},"required":["headline","score"]}}}}`)
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	if got := chatContent(t, rec); got != `{"headline":"h","score":3}` {
		t.Errorf("content = %q", got)
	}
	reqs := g.seen()
	if len(reqs) != 2 {
		t.Fatalf("want first call + one repair, got %d", len(reqs))
	}
	if reqs[0].Cookie != reqs[1].Cookie {
		t.Error("the repair must run on the first call's account")
	}
	if names := up.names(); len(names) != 2 || names[0] != "message.txt" || names[1] != "message.txt" {
		t.Fatalf("both rounds should upload message.txt: %v", names)
	}
	if up.Sizes[1] <= up.Sizes[0] {
		t.Errorf("the repair file must hold more than the first (invalid answer appended): %v", up.Sizes)
	}
	// What the model reads inline in the repair round is the repair instruction.
	if !strings.Contains(reqs[1].Prompt, "Your previous reply was rejected") ||
		!strings.Contains(reqs[1].Prompt, `missing required property "score"`) {
		t.Errorf("repair prompt:\n%s", reqs[1].Prompt)
	}
	if len(reqs[1].Refs) != 1 {
		t.Errorf("repair attachments: %d", len(reqs[1].Refs))
	}
}
