package app

// Shared helpers for the structured-output, /v1beta and attachment tests: a
// scripted fake Google (answers, uploads, the /app token page) and request
// builders.

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// rawFrames builds a StreamGenerate body with one wrb.fr content frame per
// cumulative text. reasoning (optional) goes into the thinking slot of every frame.
func rawFrames(reasoning string, texts ...string) string {
	var b strings.Builder
	b.WriteString(")]}'\n\n")
	for _, text := range texts {
		cand := make([]interface{}, 38)
		cand[0] = "rc_z"
		cand[1] = []interface{}{text}
		if reasoning != "" {
			cand[37] = []interface{}{[]interface{}{reasoning}}
		}
		inner := make([]interface{}, 43)
		inner[1] = []interface{}{"c_x", "r_y"}
		inner[4] = []interface{}{cand}
		inner[39] = "fbb127bbb056c959"
		inner[42] = "3.6 Flash"
		innerJSON, _ := json.Marshal(inner)
		line, _ := json.Marshal([]interface{}{[]interface{}{"wrb.fr", nil, string(innerJSON)}})
		b.WriteString(strconv.Itoa(len(line)) + "\n" + string(line) + "\n")
	}
	return b.String()
}

// rawText is a single-frame answer.
func rawText(text string) string { return rawFrames("", text) }

// genRequest is what the fake Google saw of one StreamGenerate call.
type genRequest struct {
	Prompt   string
	Refs     []interface{} // inner[0][3]: attachment tuples
	Cookie   string
	ModelHdr string
	Think    interface{} // inner[80]
}

func parseGenRequest(t *testing.T, r *http.Request) genRequest {
	t.Helper()
	if err := r.ParseForm(); err != nil {
		t.Fatalf("parse form: %v", err)
	}
	var outer []interface{}
	if err := json.Unmarshal([]byte(r.PostForm.Get("f.req")), &outer); err != nil || len(outer) < 2 {
		t.Fatalf("f.req is not the expected envelope: %v", err)
	}
	var inner []interface{}
	if err := json.Unmarshal([]byte(outer[1].(string)), &inner); err != nil {
		t.Fatalf("inner payload: %v", err)
	}
	in0 := inner[0].([]interface{})
	g := genRequest{
		Prompt:   in0[0].(string),
		Cookie:   r.Header.Get("Cookie"),
		ModelHdr: r.Header.Get("x-goog-ext-525001261-jspb"),
		Think:    inner[80],
	}
	if refs, ok := in0[3].([]interface{}); ok {
		g.Refs = refs
	}
	return g
}

// scriptedGoogle answers StreamGenerate from a queue and records every request.
type scriptedGoogle struct {
	*fakeGoogle
	mu       sync.Mutex
	answers  []string // consumed in order; the last one repeats
	requests []genRequest
}

func newScriptedGoogle(t *testing.T, answers ...string) *scriptedGoogle {
	t.Helper()
	s := &scriptedGoogle{fakeGoogle: newFakeGoogle(t), answers: answers}
	s.setStream(func(w http.ResponseWriter, r *http.Request) {
		req := parseGenRequest(t, r)
		s.mu.Lock()
		s.requests = append(s.requests, req)
		i := len(s.requests) - 1
		if i >= len(s.answers) {
			i = len(s.answers) - 1
		}
		ans := s.answers[i]
		s.mu.Unlock()
		writeRaw(w, 200, ans)
	})
	return s
}

func (s *scriptedGoogle) seen() []genRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]genRequest(nil), s.requests...)
}

// loginPage makes the fake /app page serve the tokens a signed-in account needs
// (XSRF, upload push id and context).
func (f *fakeGoogle) loginPage() {
	f.setApp(func(w http.ResponseWriter, r *http.Request) {
		writeRaw(w, 200, `<html>"SNlM0e":"xsrf-token-for-tests:1","qKIAYe":"push-id-1234","Ylro7b":"pctx-1234"</html>`)
	})
}

// fakeUpload stands in for the upload host and records what was uploaded.
type fakeUpload struct {
	mu    sync.Mutex
	Names []string
	Sizes []int
}

func newFakeUpload(t *testing.T) *fakeUpload {
	t.Helper()
	u := &fakeUpload{}
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		u.mu.Lock()
		defer u.mu.Unlock()
		switch {
		case r.Header.Get("X-Goog-Upload-Command") == "start":
			u.Names = append(u.Names, strings.TrimPrefix(string(body), "File name: "))
			w.Header().Set("x-goog-upload-url", srv.URL+"/put")
			w.WriteHeader(200)
		default:
			u.Sizes = append(u.Sizes, len(body))
			writeRaw(w, 200, "/contrib_service/ttl_1d/ref"+strconv.Itoa(len(u.Sizes)))
		}
	}))
	old := uploadHost
	uploadHost = srv.URL + "/upload/"
	t.Cleanup(func() { uploadHost = old; srv.Close() })
	return u
}

func (u *fakeUpload) names() []string {
	u.mu.Lock()
	defer u.mu.Unlock()
	return append([]string(nil), u.Names...)
}

// addTestAccount adds an enabled cookie account whose cookie is unique to the
// test (the XSRF cache is keyed by cookie).
func addTestAccount(t *testing.T, name string) int64 {
	t.Helper()
	cookie := "SAPISID=" + name + "; SID=x"
	id, err := accountAdd(name, cookie, "")
	if err != nil {
		t.Fatalf("add account: %v", err)
	}
	invalidateXSRF(cookie)
	t.Cleanup(func() { _ = accountDelete(id); invalidateXSRF(cookie) })
	return id
}

// withAPIKey sets the bridge API key for the test.
func withAPIKey(t *testing.T, key string) {
	t.Helper()
	old := getAPIKey()
	apiKeyRuntime.Store(key)
	t.Cleanup(func() { apiKeyRuntime.Store(old) })
}

// geminiCall invokes the /v1beta handler chain (auth included) like the server would.
func geminiCall(t *testing.T, method, target, body string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, target, rd)
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	requireGeminiKey(handleGeminiModels)(rec, req)
	return rec
}

func decodeBody(t *testing.T, rec *httptest.ResponseRecorder) map[string]interface{} {
	t.Helper()
	var m map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("body is not a JSON object: %v\n%s", err, rec.Body.String())
	}
	return m
}

// candidateText returns the concatenated non-thought text of candidate 0.
func candidateText(t *testing.T, resp map[string]interface{}) (text, thought string) {
	t.Helper()
	cands, _ := resp["candidates"].([]interface{})
	if len(cands) == 0 {
		t.Fatalf("no candidates in %v", resp)
	}
	content := cands[0].(map[string]interface{})["content"].(map[string]interface{})
	for _, p := range content["parts"].([]interface{}) {
		pm := p.(map[string]interface{})
		if isThought, _ := pm["thought"].(bool); isThought {
			thought += pm["text"].(string)
		} else {
			text += pm["text"].(string)
		}
	}
	return
}

func geminiErr(t *testing.T, rec *httptest.ResponseRecorder) (code int, status, message, reason string) {
	t.Helper()
	e, _ := decodeBody(t, rec)["error"].(map[string]interface{})
	if e == nil {
		t.Fatalf("not a Google error body: %s", rec.Body.String())
	}
	if details, ok := e["details"].([]interface{}); ok && len(details) > 0 {
		reason, _ = details[0].(map[string]interface{})["reason"].(string)
	}
	c, _ := e["code"].(float64)
	status, _ = e["status"].(string)
	message, _ = e["message"].(string)
	return int(c), status, message, reason
}

func chatContent(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var b struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &b); err != nil || len(b.Choices) == 0 {
		t.Fatalf("not a chat completion: %v\n%s", err, rec.Body.String())
	}
	return b.Choices[0].Message.Content
}
