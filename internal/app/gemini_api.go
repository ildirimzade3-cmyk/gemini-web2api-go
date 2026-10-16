package app

// Gemini-native routes (Google's generativelanguage REST shape), so a client
// that speaks the Gemini API can point at this bridge:
//
//	GET  /v1beta/models                              list
//	GET  /v1beta/models/{model}                      one model
//	POST /v1beta/models/{model}:generateContent
//	POST /v1beta/models/{model}:streamGenerateContent   (?alt=sse -> SSE, else a JSON array)
//
// Auth is the bridge API key in x-goog-api-key or ?key= (Authorization: Bearer
// and x-api-key work too). Errors use Google's {"error":{code,message,status}}
// with the same HTTP mapping as the OpenAI routes (apiErrorFor). Models, the
// thinking mapping and JSON mode are shared with the OpenAI routes; see
// model_route.go and json_mode.go.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
)

// ─── errors ──────────────────────────────────────────────────────────────────

func geminiStatusName(status int) string {
	switch status {
	case http.StatusBadRequest, http.StatusRequestEntityTooLarge, http.StatusMethodNotAllowed:
		return "INVALID_ARGUMENT"
	case http.StatusUnauthorized:
		return "UNAUTHENTICATED"
	case http.StatusForbidden:
		return "PERMISSION_DENIED"
	case http.StatusNotFound:
		return "NOT_FOUND"
	case http.StatusTooManyRequests:
		return "RESOURCE_EXHAUSTED"
	case statusClientClosed:
		return "CANCELLED"
	case http.StatusServiceUnavailable:
		return "UNAVAILABLE"
	case http.StatusGatewayTimeout:
		return "DEADLINE_EXCEEDED"
	}
	return "INTERNAL"
}

// geminiErrorBody renders an apiError in Google's error shape. The bridge's own
// code (upstream_rate_limited, upstream_invalid_json, ...) travels in an
// ErrorInfo detail so a caller can tell failure classes apart.
func geminiErrorBody(ae apiError) map[string]interface{} {
	e := map[string]interface{}{
		"code":    ae.Status,
		"message": ae.Message,
		"status":  geminiStatusName(ae.Status),
	}
	if ae.Code != "" {
		e["details"] = []map[string]interface{}{{
			"@type":  "type.googleapis.com/google.rpc.ErrorInfo",
			"reason": ae.Code,
			"domain": "gemini-web2api",
		}}
	}
	return map[string]interface{}{"error": e}
}

func writeGeminiError(w http.ResponseWriter, ae apiError) {
	if ae.RetryAfter > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(ae.RetryAfter))
	}
	writeJSON(w, ae.Status, geminiErrorBody(ae))
}

func geminiBadRequest(w http.ResponseWriter, format string, args ...interface{}) {
	writeGeminiError(w, apiError{Status: http.StatusBadRequest, Message: fmt.Sprintf(format, args...)})
}

// writeGeminiRejection answers a request refused before reaching Google.
func writeGeminiRejection(w http.ResponseWriter, err error) {
	var unk *unknownModelError
	if errors.As(err, &unk) {
		writeGeminiError(w, apiError{Status: http.StatusNotFound, Message: fmt.Sprintf(
			"models/%s is not found for API version v1beta, or is not supported for generateContent. "+
				"Call ListModels to see the available models.", unk.Name)})
		return
	}
	writeGeminiError(w, apiErrorForRejection(err))
}

// requireGeminiKey is requireAPIKey for the /v1beta routes: the key may come in
// x-goog-api-key or ?key=. A missing key is 401, a wrong one 403.
func requireGeminiKey(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			handleOptions(w, r)
			return
		}
		key := getAPIKey()
		if key == "" {
			next(w, r)
			return
		}
		got := strings.TrimSpace(r.Header.Get("x-goog-api-key"))
		if got == "" {
			got = strings.TrimSpace(r.URL.Query().Get("key"))
		}
		if got == "" {
			if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
				got = strings.TrimSpace(h[7:])
			}
		}
		if got == "" {
			got = strings.TrimSpace(r.Header.Get("x-api-key"))
		}
		switch {
		case got == "":
			writeGeminiError(w, apiError{Status: http.StatusUnauthorized, Code: "missing_api_key",
				Message: "API key is missing. Send it in the x-goog-api-key header or the key query parameter."})
		case !apiKeyMatches(got, key):
			writeGeminiError(w, apiError{Status: http.StatusForbidden, Code: "invalid_api_key",
				Message: "API key not valid. Please pass a valid API key."})
		default:
			next(w, r)
		}
	}
}

// ─── routing ─────────────────────────────────────────────────────────────────

// handleGeminiModels serves everything under /v1beta/models.
func handleGeminiModels(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(strings.TrimPrefix(r.URL.Path, "/v1beta/models"), "/")
	if rest == "" {
		if r.Method != http.MethodGet {
			writeGeminiError(w, apiError{Status: http.StatusMethodNotAllowed, Message: "method not allowed"})
			return
		}
		handleGeminiList(w)
		return
	}
	if i := strings.LastIndex(rest, ":"); i >= 0 {
		model, method := rest[:i], rest[i+1:]
		if r.Method != http.MethodPost {
			writeGeminiError(w, apiError{Status: http.StatusMethodNotAllowed, Message: "method not allowed"})
			return
		}
		switch method {
		case "generateContent":
			handleGeminiGenerate(w, r, model, false)
		case "streamGenerateContent":
			handleGeminiGenerate(w, r, model, true)
		default:
			writeGeminiError(w, apiError{Status: http.StatusNotFound,
				Message: fmt.Sprintf("method %s is not supported (generateContent and streamGenerateContent are)", method)})
		}
		return
	}
	if r.Method != http.MethodGet {
		writeGeminiError(w, apiError{Status: http.StatusMethodNotAllowed, Message: "method not allowed"})
		return
	}
	handleGeminiGetModel(w, rest)
}

func geminiModelEntry(id, display string, thinking bool, base string) map[string]interface{} {
	e := map[string]interface{}{
		"name":                       "models/" + id,
		"displayName":                display,
		"description":                Models[id].Desc,
		"inputTokenLimit":            nominalInputTokenLimit,
		"outputTokenLimit":           nominalOutputTokenLimit,
		"supportedGenerationMethods": []string{"generateContent", "streamGenerateContent"},
		"thinking":                   thinking,
	}
	if base != "" {
		e["baseModelId"] = base
	}
	return e
}

func handleGeminiList(w http.ResponseWriter) {
	entries := []map[string]interface{}{}
	for _, m := range listedModels() {
		entries = append(entries, geminiModelEntry(m.ID, m.Display, m.Thinking, m.Base))
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"models": entries})
}

func handleGeminiGetModel(w http.ResponseWriter, requested string) {
	id := cleanModelID(requested)
	fam, thinking, ok := familyOf(id)
	if !ok {
		writeGeminiRejection(w, &unknownModelError{Name: id})
		return
	}
	if _, avail := availableModels()[id]; !avail {
		writeGeminiError(w, apiError{Status: http.StatusNotFound, Message: fmt.Sprintf(
			"models/%s needs a signed-in Google account cookie and is not available right now", id)})
		return
	}
	display, base := fam.Display, ""
	if thinking {
		display += " (extended thinking)"
		base = strings.TrimSuffix(id, thinkingSuffix)
	}
	writeJSON(w, http.StatusOK, geminiModelEntry(id, display, thinking, base))
}

// ─── request ─────────────────────────────────────────────────────────────────

type gcPart struct {
	Text       *string `json:"text"`
	Thought    bool    `json:"thought"`
	InlineData *struct {
		MimeType string `json:"mimeType"`
		Data     string `json:"data"`
	} `json:"inlineData"`
	FileData *struct {
		MimeType string `json:"mimeType"`
		FileURI  string `json:"fileUri"`
	} `json:"fileData"`
	FunctionCall        json.RawMessage `json:"functionCall"`
	FunctionResponse    json.RawMessage `json:"functionResponse"`
	ExecutableCode      json.RawMessage `json:"executableCode"`
	CodeExecutionResult json.RawMessage `json:"codeExecutionResult"`
}

type gcContent struct {
	Role  string   `json:"role"`
	Parts []gcPart `json:"parts"`
}

type gcThinkingConfig struct {
	IncludeThoughts bool     `json:"includeThoughts"`
	ThinkingLevel   string   `json:"thinkingLevel"`
	ThinkingBudget  *float64 `json:"thinkingBudget"`
}

type gcGenerationConfig struct {
	ResponseMimeType   string            `json:"responseMimeType"`
	ResponseSchema     interface{}       `json:"responseSchema"`
	ResponseJSONSchema interface{}       `json:"responseJsonSchema"`
	ThinkingConfig     *gcThinkingConfig `json:"thinkingConfig"`
	CandidateCount     *int              `json:"candidateCount"`
	// temperature, topP, topK, maxOutputTokens, stopSequences, ... are accepted
	// and ignored: the web app has no such knobs and output is never cut.
}

type gcRequest struct {
	Contents          []gcContent         `json:"contents"`
	SystemInstruction *gcContent          `json:"systemInstruction"`
	GenerationConfig  *gcGenerationConfig `json:"generationConfig"`
	Tools             []json.RawMessage   `json:"tools"`
}

// geminiMessages converts contents / systemInstruction into the OpenAI-style
// messages the shared prompt and attachment code works on.
func geminiMessages(req *gcRequest) ([]map[string]interface{}, error) {
	var msgs []map[string]interface{}
	if si := req.SystemInstruction; si != nil {
		var texts []string
		for _, p := range si.Parts {
			if p.Text == nil {
				return nil, errUnsupportedInput("systemInstruction supports text parts only")
			}
			texts = append(texts, *p.Text)
		}
		if t := strings.Join(texts, "\n"); strings.TrimSpace(t) != "" {
			msgs = append(msgs, map[string]interface{}{"role": "system", "content": t})
		}
	}
	for i, c := range req.Contents {
		role := ""
		switch c.Role {
		case "", "user":
			role = "user"
		case "model":
			role = "assistant"
		default:
			return nil, errUnsupportedInput("contents[%d].role %q is not supported (use user or model)", i, c.Role)
		}
		var parts []interface{}
		for j, p := range c.Parts {
			switch {
			case p.Thought:
				continue // thoughts echoed back from a previous reply carry no input
			case len(p.FunctionCall) > 0 || len(p.FunctionResponse) > 0:
				return nil, errUnsupportedInput("contents[%d].parts[%d]: function calling is not supported on this API", i, j)
			case len(p.ExecutableCode) > 0 || len(p.CodeExecutionResult) > 0:
				return nil, errUnsupportedInput("contents[%d].parts[%d]: code execution parts are not supported", i, j)
			case p.Text != nil:
				parts = append(parts, map[string]interface{}{"type": "text", "text": *p.Text})
			case p.InlineData != nil:
				parts = append(parts, map[string]interface{}{
					"type": partGeminiInline, "mime_type": p.InlineData.MimeType, "data": p.InlineData.Data})
			case p.FileData != nil:
				parts = append(parts, map[string]interface{}{
					"type": partGeminiFile, "mime_type": p.FileData.MimeType, "file_uri": p.FileData.FileURI})
			default:
				return nil, errUnsupportedInput("contents[%d].parts[%d]: the part has no text, inlineData or fileData", i, j)
			}
		}
		if len(parts) == 0 {
			continue
		}
		msgs = append(msgs, map[string]interface{}{"role": role, "content": parts})
	}
	return msgs, nil
}

// jsonSpecFromGemini reads generationConfig: responseMimeType application/json
// switches JSON mode on; a responseJsonSchema / responseSchema adds the schema.
// A schema without the mime type is honoured too (Google would refuse it).
func jsonSpecFromGemini(cfg *gcGenerationConfig) (*jsonSpec, error) {
	if cfg == nil {
		return nil, nil
	}
	schema := cfg.ResponseJSONSchema
	if schema == nil {
		schema = cfg.ResponseSchema
	}
	switch strings.ToLower(strings.TrimSpace(cfg.ResponseMimeType)) {
	case "", "text/plain":
		if schema == nil {
			return nil, nil
		}
	case "application/json":
	default:
		return nil, errUnsupportedInput("generationConfig.responseMimeType %q is not supported (text/plain and application/json are)",
			cfg.ResponseMimeType)
	}
	if schema == nil {
		return &jsonSpec{Root: jsonRootAny}, nil
	}
	return newJSONSpec(schema, false, "")
}

// ─── response ────────────────────────────────────────────────────────────────

type geminiOut struct {
	model, id string
}

func (g geminiOut) chunk(parts []map[string]interface{}, finish string, usage map[string]int) map[string]interface{} {
	cand := map[string]interface{}{
		"content": map[string]interface{}{"role": "model", "parts": parts},
		"index":   0,
	}
	if finish != "" {
		cand["finishReason"] = finish
	}
	c := map[string]interface{}{
		"candidates":   []map[string]interface{}{cand},
		"modelVersion": g.model,
		"responseId":   g.id,
	}
	if usage != nil {
		c["usageMetadata"] = usage
	}
	return c
}

func textPart(t string) map[string]interface{} { return map[string]interface{}{"text": t} }

func thoughtPart(t string) map[string]interface{} {
	return map[string]interface{}{"text": t, "thought": true}
}

func geminiUsage(prompt, text, reasoning string) map[string]int {
	in, out := countTokens(prompt), countTokens(stripDataURLs(text))
	u := map[string]int{"promptTokenCount": in, "candidatesTokenCount": out}
	th := 0
	if reasoning != "" {
		th = countTokens(reasoning)
		u["thoughtsTokenCount"] = th
	}
	u["totalTokenCount"] = in + out + th
	return u
}

// geminiStream writes streamGenerateContent frames. The header goes out with the
// first frame, so a failure before any output still gets a proper error status.
type geminiStream struct {
	w       http.ResponseWriter
	flusher http.Flusher
	sse     bool
	started bool
	frames  int
}

func newGeminiStream(w http.ResponseWriter, sse bool) *geminiStream {
	f, _ := w.(http.Flusher)
	return &geminiStream{w: w, flusher: f, sse: sse}
}

func (g *geminiStream) frame(obj interface{}) {
	b, _ := json.Marshal(obj)
	if !g.started {
		g.started = true
		h := g.w.Header()
		if g.sse {
			h.Set("Content-Type", "text/event-stream")
		} else {
			h.Set("Content-Type", "application/json")
		}
		h.Set("Cache-Control", "no-cache")
		h.Set("X-Accel-Buffering", "no")
		h.Set("Access-Control-Allow-Origin", "*")
		g.w.WriteHeader(http.StatusOK)
	}
	switch {
	case g.sse:
		fmt.Fprintf(g.w, "data: %s\n\n", b)
	case g.frames == 0:
		fmt.Fprintf(g.w, "[%s", b)
	default:
		fmt.Fprintf(g.w, ",\n%s", b)
	}
	g.frames++
	if g.flusher != nil {
		g.flusher.Flush()
	}
}

// finish closes a JSON-array stream.
func (g *geminiStream) finish() {
	if !g.sse && g.started {
		io.WriteString(g.w, "\n]")
		if g.flusher != nil {
			g.flusher.Flush()
		}
	}
}

// ─── generate ────────────────────────────────────────────────────────────────

func handleGeminiGenerate(w http.ResponseWriter, r *http.Request, requestedModel string, stream bool) {
	endpoint := "gemini.generateContent"
	if stream {
		endpoint = "gemini.streamGenerateContent"
	}
	// The model comes first, as at Google: an unknown model is 404 whatever the body says.
	if _, _, ok := familyOf(cleanModelID(requestedModel)); !ok {
		writeGeminiRejection(w, &unknownModelError{Name: cleanModelID(requestedModel)})
		return
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			writeGeminiError(w, apiError{Status: http.StatusRequestEntityTooLarge, Code: "request_too_large",
				Message: fmt.Sprintf("request body too large: the limit is %d MB", maxRequestBodyBytes>>20)})
			return
		}
		geminiBadRequest(w, "%s", err.Error())
		return
	}
	var req gcRequest
	if err := json.Unmarshal(body, &req); err != nil {
		geminiBadRequest(w, "Invalid JSON payload received: %s", err.Error())
		return
	}
	if len(req.Tools) > 0 {
		geminiBadRequest(w, "tools are not supported on the /v1beta routes (function calling is available on /v1/chat/completions)")
		return
	}
	cfg := req.GenerationConfig
	if cfg != nil && cfg.CandidateCount != nil && *cfg.CandidateCount > 1 {
		geminiBadRequest(w, "candidateCount=%d is not supported: upstream returns a single candidate", *cfg.CandidateCount)
		return
	}

	wantThinking, includeThoughts := false, false
	if cfg != nil && cfg.ThinkingConfig != nil {
		tc := cfg.ThinkingConfig
		wantThinking = thinkingFromGemini(tc.ThinkingLevel, tc.ThinkingBudget)
		includeThoughts = tc.IncludeThoughts
	}
	modelName, modelCfg, err := routeFamilyModel(requestedModel, wantThinking)
	if err != nil {
		writeGeminiRejection(w, err)
		return
	}
	spec, err := jsonSpecFromGemini(cfg)
	if err != nil {
		writeGeminiRejection(w, err)
		return
	}
	messages, err := geminiMessages(&req)
	if err != nil {
		writeGeminiRejection(w, err)
		return
	}
	if len(messages) == 0 {
		geminiBadRequest(w, "contents is required and must hold at least one part")
		return
	}
	if err := rejectUnsupported(map[string]interface{}{}, messages); err != nil {
		writeGeminiRejection(w, err)
		return
	}
	attachments, err := collectAttachments(messages, "")
	if err != nil {
		writeGeminiRejection(w, err)
		return
	}
	prompt, latest := messagesToPrompt(messages, nil, nil)
	if strings.TrimSpace(prompt) == "" && len(attachments) == 0 {
		geminiBadRequest(w, "contents holds no text")
		return
	}

	out := geminiOut{model: modelName, id: randHex(16)}
	gs := newGeminiStream(w, r.URL.Query().Get("alt") == "sse")
	var onDelta, onReasoning func(string)
	if stream && spec == nil {
		onDelta = func(d string) { gs.frame(out.chunk([]map[string]interface{}{textPart(d)}, "", nil)) }
		if includeThoughts {
			onReasoning = func(d string) { gs.frame(out.chunk([]map[string]interface{}{thoughtPart(d)}, "", nil)) }
		}
	}

	text, _, res, err := runGeneration(r.Context(), generationJob{
		Messages: messages, Prompt: prompt, Latest: latest, Model: modelCfg,
		Attachments: attachments, JSON: spec,
	}, onDelta, onReasoning)
	if err != nil {
		ae := apiErrorFor(err)
		recordRequest(endpoint, modelName, prompt, "", res, ae.Status, err.Error(), stream)
		switch {
		case gs.started && gs.sse:
			b, _ := json.Marshal(geminiErrorBody(ae))
			fmt.Fprintf(w, "data: %s\n\n", b)
		case gs.started:
			gs.frame(geminiErrorBody(ae))
			gs.finish()
		default:
			writeGeminiError(w, ae)
		}
		return
	}

	// Thinking tokens are counted whether or not the thought text is returned.
	allReasoning, reasoning := "", ""
	if res != nil {
		allReasoning = res.Reasoning
		if includeThoughts {
			reasoning = allReasoning
		}
	}
	usage := geminiUsage(prompt, text, allReasoning)
	recordRequest(endpoint, modelName, prompt, text, res, 200, "", stream)

	if !stream {
		var parts []map[string]interface{}
		if reasoning != "" {
			parts = append(parts, thoughtPart(reasoning))
		}
		parts = append(parts, textPart(text))
		writeJSON(w, http.StatusOK, out.chunk(parts, "STOP", usage))
		return
	}

	// Tail of whatever was not streamed live: all of it for JSON mode and for an
	// upstream that did not stream, a few characters otherwise.
	if reasoning != "" {
		if rest := remainingOf(reasoning, res.EmittedReasoning); rest != "" {
			gs.frame(out.chunk([]map[string]interface{}{thoughtPart(rest)}, "", nil))
		}
	}
	emitted := ""
	if res != nil {
		emitted = res.Emitted
	}
	gs.frame(out.chunk([]map[string]interface{}{textPart(remainingOf(text, emitted))}, "STOP", usage))
	gs.finish()
}
