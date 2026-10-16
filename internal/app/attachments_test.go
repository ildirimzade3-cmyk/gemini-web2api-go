package app

import (
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNewUploadKindsAndCaps(t *testing.T) {
	b := func(n int) []byte { return make([]byte, n) }
	cases := []struct {
		name, mime, filename string
		size                 int
		kind                 int
		wantMime, wantName   string
		status               int // 0 = accepted
	}{
		{"png", "image/png", "", 10, 1, "image/png", "image1.png", 0},
		{"jpeg upper case", "IMAGE/JPEG", "", 10, 1, "image/jpeg", "image1.jpg", 0},
		{"mp4", "video/mp4", "", 10, 2, "video/mp4", "video1.mp4", 0},
		{"pdf", "application/pdf", "report.pdf", 10, 3, "application/pdf", "report.pdf", 0},
		{"pdf without a name", "application/pdf", "", 10, 3, "application/pdf", "file1.pdf", 0},
		{"name without extension", "application/pdf", "report", 10, 3, "application/pdf", "report.pdf", 0},
		{"path stripped", "text/plain", `C:\tmp\..\notes.txt`, 10, 3, "text/plain", "notes.txt", 0},
		{"text with params", "text/plain; charset=utf-8", "", 10, 3, "text/plain", "file1.txt", 0},
		{"markdown", "text/markdown", "", 10, 3, "text/markdown", "file1.md", 0},
		{"csv", "text/csv", "", 10, 3, "text/csv", "file1.csv", 0},
		{"json", "application/json", "", 10, 3, "application/json", "file1.json", 0},
		{"audio", "audio/mpeg", "", 10, 3, "audio/mpeg", "file1.mp3", 0},
		{"docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "", 10, 3,
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document", "file1.docx", 0},
		{"image at the cap", "image/png", "", maxImageBytes, 1, "image/png", "image1.png", 0},
		{"image over the cap", "image/png", "", maxImageBytes + 1, 0, "", "", 413},
		{"video over the cap", "video/mp4", "", maxVideoBytes + 1, 0, "", "", 413},
		{"file over the cap", "application/pdf", "", maxFileBytes + 1, 0, "", "", 413},
		{"a video may exceed the image cap", "video/mp4", "", maxImageBytes + 1, 2, "video/mp4", "video1.mp4", 0},
		{"zip", "application/zip", "", 10, 0, "", "", 400},
		{"octet-stream", "application/octet-stream", "", 10, 0, "", "", 400},
		{"executable", "application/x-msdownload", "", 10, 0, "", "", 400},
		{"unknown type", "", "", 10, 0, "", "", 400},
		{"empty", "image/png", "", 0, 0, "", "", 400},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			up, err := newUpload(b(c.size), c.mime, c.filename, 1)
			if c.status != 0 {
				ce, ok := errorAsClient(err)
				if !ok || ce.Status != c.status {
					t.Fatalf("want a clientError with status %d, got %v", c.status, err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if up.Kind != c.kind || up.Mime != c.wantMime || up.Name != c.wantName {
				t.Errorf("got kind=%d mime=%q name=%q; want %d %q %q", up.Kind, up.Mime, up.Name, c.kind, c.wantMime, c.wantName)
			}
		})
	}
}

func b64(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

func parts(ps ...map[string]interface{}) []map[string]interface{} {
	items := make([]interface{}, len(ps))
	for i, p := range ps {
		items[i] = p
	}
	return []map[string]interface{}{{"role": "user", "content": items}}
}

func TestCollectAttachmentsOpenAIParts(t *testing.T) {
	msgs := parts(
		map[string]interface{}{"type": "text", "text": "read these"},
		map[string]interface{}{"type": "image_url", "image_url": map[string]interface{}{"url": "data:image/png;base64," + b64("png-bytes")}},
		map[string]interface{}{"type": "input_image", "image_url": "data:image/jpeg;base64," + b64("jpg-bytes")},
		map[string]interface{}{"type": "video_url", "video_url": map[string]interface{}{"url": "data:video/mp4;base64," + b64("mp4-bytes")}},
		map[string]interface{}{"type": "file", "file": map[string]interface{}{
			"file_data": "data:application/pdf;base64," + b64("%PDF-1.7"), "filename": "brief.pdf"}},
		map[string]interface{}{"type": "input_file", "file_data": "data:text/csv;base64," + b64("a,b\n1,2"), "filename": "t.csv"},
		map[string]interface{}{"type": "input_file", "file_data": b64("plain notes"), "filename": "notes.txt"},
		map[string]interface{}{"type": "input_audio", "input_audio": map[string]interface{}{"data": b64("RIFFwav"), "format": "wav"}},
		map[string]interface{}{"type": "input_audio", "input_audio": map[string]interface{}{"data": b64("ID3mp3"), "format": "mp3"}},
	)
	got, err := collectAttachments(msgs, "")
	if err != nil {
		t.Fatal(err)
	}
	type row struct {
		kind       int
		mime, name string
		size       int
	}
	want := []row{
		{1, "image/png", "image1.png", 9},
		{1, "image/jpeg", "image2.jpg", 9},
		{2, "video/mp4", "video3.mp4", 9},
		{3, "application/pdf", "brief.pdf", 8},
		{3, "text/csv", "t.csv", 7},
		{3, "text/plain", "notes.txt", 11},
		{3, "audio/wav", "file7.wav", 7},
		{3, "audio/mpeg", "file8.mp3", 6},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d attachments, want %d", len(got), len(want))
	}
	for i, w := range want {
		g := got[i]
		if g.Kind != w.kind || g.Mime != w.mime || g.Name != w.name || len(g.Data) != w.size {
			t.Errorf("#%d: got kind=%d mime=%s name=%s size=%d; want %+v", i, g.Kind, g.Mime, g.Name, len(g.Data), w)
		}
	}
}

func TestCollectAttachmentsRejections(t *testing.T) {
	cases := map[string]map[string]interface{}{
		"file_id":                    {"type": "file", "file": map[string]interface{}{"file_id": "file-abc"}},
		"unknown type":               {"type": "input_file", "file_data": b64("x"), "filename": "tool.exe"},
		"bare base64 without a name": {"type": "input_file", "file_data": b64("x")},
		"zip data URL":               {"type": "file", "file": map[string]interface{}{"file_data": "data:application/zip;base64," + b64("PK")}},
		"audio without format":       {"type": "input_audio", "input_audio": map[string]interface{}{"data": b64("x")}},
		"bad base64":                 {"type": "input_file", "file_data": "!!!not base64!!!", "filename": "a.txt"},
		"gemini gs uri":              {"type": partGeminiFile, "mime_type": "application/pdf", "file_uri": "gs://b/o.pdf"},
		"gemini files api":           {"type": partGeminiFile, "mime_type": "application/pdf", "file_uri": "files/abc123"},
		"gemini inline without mime": {"type": partGeminiInline, "data": b64("x")},
	}
	for name, part := range cases {
		if _, err := collectAttachments(parts(part), ""); err == nil {
			t.Errorf("%s: should be refused", name)
		} else if ce, ok := errorAsClient(err); name != "bad base64" && (!ok || ce.Status != 400) {
			t.Errorf("%s: want a 400 clientError, got %T %v", name, err, err)
		}
	}
	// oversized -> 413
	big := base64.StdEncoding.EncodeToString(make([]byte, maxImageBytes+1))
	_, err := collectAttachments(parts(map[string]interface{}{"type": "image_url",
		"image_url": map[string]interface{}{"url": "data:image/png;base64," + big}}), "")
	if ce, ok := errorAsClient(err); !ok || ce.Status != 413 || ce.Code != "attachment_too_large" {
		t.Errorf("oversized image: %v", err)
	}
}

// fileUri / file_url / image_url links are fetched; the type comes from the response.
func TestCollectAttachmentsFetchesLinks(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/doc.pdf":
			w.Header().Set("Content-Type", "application/pdf")
		case "/plain":
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		case "/page":
			w.Header().Set("Content-Type", "text/html")
		case "/pic":
			w.Header().Set("Content-Type", "image/webp")
		case "/gone":
			w.WriteHeader(404)
			return
		}
		_, _ = w.Write([]byte("0123456789"))
	}))
	defer srv.Close()

	got, err := collectAttachments(parts(
		map[string]interface{}{"type": partGeminiFile, "mime_type": "application/pdf", "file_uri": srv.URL + "/doc.pdf"},
		map[string]interface{}{"type": "input_file", "file_url": srv.URL + "/plain", "filename": "n.txt"},
		map[string]interface{}{"type": "image_url", "image_url": map[string]interface{}{"url": srv.URL + "/pic"}},
		map[string]interface{}{"type": "image_url", "image_url": map[string]interface{}{"url": srv.URL + "/page"}}, // legacy rule: not image/video -> image
	), "")
	if err != nil {
		t.Fatal(err)
	}
	want := []struct {
		kind       int
		mime, name string
	}{
		{3, "application/pdf", "doc.pdf"},
		{3, "text/plain", "n.txt"},
		{1, "image/webp", "image3.webp"},
		{1, "image/png", "image4.png"},
	}
	for i, w := range want {
		if got[i].Kind != w.kind || got[i].Mime != w.mime || got[i].Name != w.name {
			t.Errorf("#%d: got %d %s %s, want %+v", i, got[i].Kind, got[i].Mime, got[i].Name, w)
		}
	}
	if _, err := collectAttachments(parts(map[string]interface{}{"type": partGeminiFile, "file_uri": srv.URL + "/gone"}), ""); err == nil {
		t.Error("a 404 link must fail")
	}
}

// input_audio used to be refused outright; now it is an attachment like the rest.
func TestAttachmentsNeedAnAccountButAudioIsNoLongerRefused(t *testing.T) {
	if hasCookie() {
		t.Skip("cookie pool is not empty")
	}
	msgs := parts(map[string]interface{}{"type": "input_audio", "input_audio": map[string]interface{}{"data": b64("x"), "format": "wav"}})
	err := rejectUnsupported(map[string]interface{}{}, msgs)
	if err == nil || upstreamClassOf(err) != ClassNoAccount || strings.Contains(err.Error(), "audio input not supported") {
		t.Fatalf("without an account every attachment is a no_valid_account error: %v", err)
	}
	addTestAccount(t, "audio-acct")
	if err := rejectUnsupported(map[string]interface{}{}, msgs); err != nil {
		t.Errorf("with an account audio is accepted: %v", err)
	}
}

const attachChat = `{"model":"gemini-3.6-flash","messages":[{"role":"user","content":[
	{"type":"text","text":"Compare the files."},
	{"type":"image_url","image_url":{"url":"data:image/png;base64,UE5H"}},
	{"type":"video_url","video_url":{"url":"data:video/mp4;base64,TVA0"}},
	{"type":"file","file":{"file_data":"data:application/pdf;base64,JVBERi0=","filename":"brief.pdf"}},
	{"type":"input_audio","input_audio":{"data":"UklGRg==","format":"wav"}}
]}]}`

func refTuple(t *testing.T, ref interface{}) (kind float64, mime, name string) {
	t.Helper()
	tuple := ref.([]interface{})
	head := tuple[0].([]interface{})
	return head[1].(float64), head[3].(string), tuple[1].(string)
}

func TestAttachmentsReachGoogleWithTheirKindAndMime(t *testing.T) {
	withRuntime(t, nil)
	resetBLState(t)
	addTestAccount(t, "attach-acct")
	up := newFakeUpload(t)
	g := newScriptedGoogle(t, rawText("compared"))
	g.loginPage()

	check := func(label string) {
		t.Helper()
		reqs := g.seen()
		refs := reqs[len(reqs)-1].Refs
		type row struct {
			kind       float64
			mime, name string
		}
		want := []row{
			{1, "image/png", "image1.png"},
			{2, "video/mp4", "video2.mp4"},
			{3, "application/pdf", "brief.pdf"},
			{3, "audio/wav", "file4.wav"},
		}
		if len(refs) != len(want) {
			t.Fatalf("%s: %d refs, want %d", label, len(refs), len(want))
		}
		for i, w := range want {
			k, m, n := refTuple(t, refs[i])
			if k != w.kind || m != w.mime || n != w.name {
				t.Errorf("%s ref #%d = %v %s %s, want %+v", label, i, k, m, n, w)
			}
		}
	}

	rec := postJSON(t, handleChatCompletions, "/v1/chat/completions", attachChat)
	if rec.Code != 200 {
		t.Fatalf("chat: %d %s", rec.Code, rec.Body.String())
	}
	check("chat")
	if got := up.names(); len(got) != 4 || got[2] != "brief.pdf" {
		t.Errorf("uploaded names: %v", got)
	}

	// The same four files through the Gemini route (inlineData).
	rec = geminiCall(t, "POST", genPath, `{"contents":[{"role":"user","parts":[
		{"text":"Compare the files."},
		{"inlineData":{"mimeType":"image/png","data":"UE5H"}},
		{"inlineData":{"mimeType":"video/mp4","data":"TVA0"}},
		{"inlineData":{"mimeType":"application/pdf","data":"JVBERi0="}},
		{"inlineData":{"mimeType":"audio/wav","data":"UklGRg=="}}]}]}`, nil)
	if rec.Code != 200 {
		t.Fatalf("gemini: %d %s", rec.Code, rec.Body.String())
	}
	reqs := g.seen()
	for i, w := range []struct {
		kind float64
		mime string
	}{{1, "image/png"}, {2, "video/mp4"}, {3, "application/pdf"}, {3, "audio/wav"}} {
		k, m, _ := refTuple(t, reqs[len(reqs)-1].Refs[i])
		if k != w.kind || m != w.mime {
			t.Errorf("gemini ref #%d = %v %s, want %v %s", i, k, m, w.kind, w.mime)
		}
	}

	// Responses API: input_file next to input_text.
	rec = postJSON(t, handleResponses, "/v1/responses", `{"model":"gemini-3.6-flash","input":[{"role":"user","content":[
		{"type":"input_text","text":"summarise"},
		{"type":"input_file","file_data":"data:text/plain;base64,aGk=","filename":"hi.txt"}]}]}`)
	if rec.Code != 200 {
		t.Fatalf("responses: %d %s", rec.Code, rec.Body.String())
	}
	reqs = g.seen()
	if k, m, n := refTuple(t, reqs[len(reqs)-1].Refs[0]); k != 3 || m != "text/plain" || n != "hi.txt" {
		t.Errorf("responses ref = %v %s %s", k, m, n)
	}
}

// Unsupported or oversized files are refused in the shape of the API that was called.
func TestAttachmentRefusalShapes(t *testing.T) {
	withRuntime(t, nil)
	resetBLState(t)
	addTestAccount(t, "refuse-acct")
	g := newScriptedGoogle(t, rawText("x"))
	g.loginPage()
	newFakeUpload(t)

	zip := `{"model":"gemini-3.6-flash","messages":[{"role":"user","content":[{"type":"file","file":{"file_data":"data:application/zip;base64,UEs=","filename":"a.zip"}}]}]}`
	rec := postJSON(t, handleChatCompletions, "/v1/chat/completions", zip)
	if rec.Code != 400 {
		t.Fatalf("zip: %d %s", rec.Code, rec.Body.String())
	}
	if _, code, _ := errorBody(t, rec); code != "unsupported_input" {
		t.Errorf("zip code = %q", code)
	}
	rec = geminiCall(t, "POST", genPath, `{"contents":[{"parts":[{"inlineData":{"mimeType":"application/zip","data":"UEs="}}]}]}`, nil)
	if code, status, _, _ := geminiErr(t, rec); rec.Code != 400 || code != 400 || status != "INVALID_ARGUMENT" {
		t.Errorf("gemini zip: %d %d %s", rec.Code, code, status)
	}

	big := base64.StdEncoding.EncodeToString(make([]byte, maxImageBytes+1))
	rec = postJSON(t, handleChatCompletions, "/v1/chat/completions",
		`{"model":"gemini-3.6-flash","messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,`+big+`"}}]}]}`)
	if rec.Code != 413 {
		t.Fatalf("oversized image: %d", rec.Code)
	}
	if _, code, _ := errorBody(t, rec); code != "attachment_too_large" {
		t.Errorf("oversized code = %q", code)
	}
	rec = geminiCall(t, "POST", genPath, `{"contents":[{"parts":[{"inlineData":{"mimeType":"image/png","data":"`+big+`"}}]}]}`, nil)
	if code, status, _, _ := geminiErr(t, rec); rec.Code != 413 || code != 413 || status != "INVALID_ARGUMENT" {
		t.Errorf("gemini oversized: %d %d %s", rec.Code, code, status)
	}
	if g.streamHits.Load() != 0 {
		t.Error("refused files must never reach Google")
	}
}
