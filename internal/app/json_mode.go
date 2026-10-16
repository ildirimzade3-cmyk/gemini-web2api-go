package app

// Structured JSON output.
//
// Google's web app has no response-schema switch, so JSON mode is prompt-level:
// a strict format block is appended to the prompt, the answer is cut down to its
// outermost JSON value, parsed, and (with a schema) validated. One failed check
// triggers ONE repair round in the same request: the invalid answer and the
// validation error go back to the model on the same cookie account. Still
// invalid -> 503 upstream_invalid_json, so a caller's pool can fail over.
//
// JSON requests are buffered (streaming clients get the clean JSON in one piece
// at the end), always use the single-turn prompt path (multi_turn is bypassed)
// and cannot be combined with tools.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// ClassInvalidJSON: the model answered, but not with JSON that satisfies the
// request, even after the repair round. Maps to 503 like the other upstream
// failures, with its own code so callers can tell it apart.
const ClassInvalidJSON ErrClass = "upstream_invalid_json"

const (
	jsonRootObject = "object"
	jsonRootArray  = "array"
	jsonRootAny    = "any"
)

// jsonSpec is what a request asks of the answer.
type jsonSpec struct {
	Schema map[string]interface{} // normalised JSON Schema; nil = any valid JSON
	Root   string                 // jsonRootObject / jsonRootArray / jsonRootAny
	Strict bool
	Name   string
}

// newJSONSpec builds a spec from a client schema (nil = json_object mode). Root
// follows the schema's type: array, otherwise object.
func newJSONSpec(schema interface{}, strict bool, name string) (*jsonSpec, error) {
	spec := &jsonSpec{Root: jsonRootObject, Strict: strict, Name: name}
	if schema == nil {
		return spec, nil
	}
	norm, ok := normalizeSchema(schema).(map[string]interface{})
	if !ok {
		return nil, errors.New("the JSON schema must be an object")
	}
	spec.Schema = norm
	switch t := schemaTypes(norm); {
	case len(t) == 0, containsString(t, "object"):
	case containsString(t, "array"):
		spec.Root = jsonRootArray
	default:
		return nil, fmt.Errorf("the root of the JSON schema must be an object or an array, not %s", strings.Join(t, "/"))
	}
	return spec, nil
}

// jsonSpecFromChat reads response_format of /v1/chat/completions.
func jsonSpecFromChat(req map[string]interface{}) (*jsonSpec, error) {
	rf, ok := req["response_format"].(map[string]interface{})
	if !ok {
		return nil, nil
	}
	switch t := getStr(rf, "type"); t {
	case "", "text":
		return nil, nil
	case "json_object":
		return newJSONSpec(nil, false, "")
	case "json_schema":
		js, _ := rf["json_schema"].(map[string]interface{})
		if js == nil || js["schema"] == nil {
			return nil, errors.New("response_format.json_schema.schema is required")
		}
		strict, _ := js["strict"].(bool)
		return newJSONSpec(js["schema"], strict, getStr(js, "name"))
	default:
		return nil, fmt.Errorf("unsupported response_format.type %q (want text, json_object or json_schema)", t)
	}
}

// jsonSpecFromResponses reads text.format of /v1/responses (flat shape:
// {type, name, schema, strict}; the chat shape with a nested json_schema is
// tolerated too).
func jsonSpecFromResponses(req map[string]interface{}) (*jsonSpec, error) {
	text, _ := req["text"].(map[string]interface{})
	f, ok := text["format"].(map[string]interface{})
	if !ok {
		return nil, nil
	}
	switch t := getStr(f, "type"); t {
	case "", "text":
		return nil, nil
	case "json_object":
		return newJSONSpec(nil, false, "")
	case "json_schema":
		src := f
		if nested, ok := f["json_schema"].(map[string]interface{}); ok {
			src = nested
		}
		if src["schema"] == nil {
			return nil, errors.New("text.format.schema is required for json_schema")
		}
		strict, _ := src["strict"].(bool)
		return newJSONSpec(src["schema"], strict, getStr(src, "name"))
	default:
		return nil, fmt.Errorf("unsupported text.format.type %q (want text, json_object or json_schema)", t)
	}
}

func (s *jsonSpec) rootNoun() string {
	switch s.Root {
	case jsonRootArray:
		return "JSON array"
	case jsonRootAny:
		return "JSON value (an object or an array)"
	}
	return "JSON object"
}

// instruction is the strict format block appended to the prompt.
func (s *jsonSpec) instruction() string {
	var b strings.Builder
	b.WriteString("[System instruction — output format, highest priority]: ")
	fmt.Fprintf(&b, "Reply with exactly one %s and nothing else. ", s.rootNoun())
	b.WriteString("No markdown code fences, no text before or after it, no comments, no trailing commas; " +
		"use double-quoted keys and strings.")
	if s.Schema != nil {
		raw, _ := json.Marshal(s.Schema)
		b.WriteString("\nThe reply must conform to this JSON Schema")
		if s.Name != "" {
			fmt.Fprintf(&b, " (%s)", s.Name)
		}
		b.WriteString(":\n")
		b.Write(raw)
		if s.Strict {
			b.WriteString("\nStrict: include every required property, add no property that the schema does not declare, " +
				"and use the declared types and enum values exactly.")
		}
	}
	return b.String()
}

func (s *jsonSpec) repairInstruction(p *jsonProblem) string {
	var b strings.Builder
	b.WriteString("[System instruction — output format, highest priority]: ")
	fmt.Fprintf(&b, "Your previous reply was rejected: %s. ", p.Repair())
	fmt.Fprintf(&b, "Reply again with the corrected %s only — no explanation, no apology, no markdown code fences.", s.rootNoun())
	return b.String()
}

// extractJSON cuts the outermost JSON value out of an answer: a surrounding
// markdown fence and any prose around the value are dropped. The first '{' (or
// '[' for an array root) starts the value; the matching close ends it.
func extractJSON(text, root string) (string, *jsonProblem) {
	s := strings.TrimSpace(text)
	if strings.HasPrefix(s, "```") {
		if nl := strings.IndexByte(s, '\n'); nl >= 0 {
			s = s[nl+1:]
		}
		if end := strings.LastIndex(s, "```"); end >= 0 {
			s = s[:end]
		}
	}
	start := -1
	switch root {
	case jsonRootObject:
		start = strings.IndexByte(s, '{')
	case jsonRootArray:
		start = strings.IndexByte(s, '[')
	default:
		o, a := strings.IndexByte(s, '{'), strings.IndexByte(s, '[')
		start = o
		if o < 0 || (a >= 0 && a < o) {
			start = a
		}
	}
	if start < 0 {
		noun := map[string]string{jsonRootObject: "object", jsonRootArray: "array", jsonRootAny: "value"}[root]
		return "", problem("$", "the reply contains no JSON "+noun)
	}
	end := matchingClose(s, start)
	if end < 0 {
		return "", problem("$", "the JSON in the reply is incomplete (it ends before the value is closed)")
	}
	return s[start : end+1], nil
}

// matchingClose returns the index of the bracket that closes the one at start,
// or -1. Brackets inside strings do not count.
func matchingClose(s string, start int) int {
	depth, inStr, esc := 0, false, false
	for i := start; i < len(s); i++ {
		c := s[i]
		if inStr {
			switch {
			case esc:
				esc = false
			case c == '\\':
				esc = true
			case c == '"':
				inStr = false
			}
			continue
		}
		switch c {
		case '"':
			inStr = true
		case '{', '[':
			depth++
		case '}', ']':
			depth--
			if depth == 0 {
				return i
			}
		}
	}
	return -1
}

// checkJSONAnswer returns the clean JSON text of an answer, or why it fails.
func checkJSONAnswer(text string, spec *jsonSpec) (string, *jsonProblem) {
	clean, p := extractJSON(text, spec.Root)
	if p != nil {
		return "", p
	}
	dec := json.NewDecoder(strings.NewReader(clean))
	dec.UseNumber()
	var val interface{}
	if err := dec.Decode(&val); err != nil {
		reason := "the reply is not valid JSON"
		var se *json.SyntaxError
		if errors.As(err, &se) {
			reason = fmt.Sprintf("the reply is not valid JSON (syntax error at byte %d)", se.Offset)
		}
		return "", problem("$", reason)
	}
	if spec.Schema != nil {
		if p := validateJSON(spec.Schema, val); p != nil {
			return "", p
		}
	}
	return clean, nil
}

// jsonGenerator makes one Google call for a prompt and returns the answer text.
type jsonGenerator func(ctx context.Context, prompt, latest string) (string, *StreamResult, error)

// runJSONMode generates, checks and, if needed, repairs once. prompt/latest are
// the plain request; the format block is added here. The returned StreamResult
// is the last call's; TotalMs covers both calls.
func runJSONMode(ctx context.Context, spec *jsonSpec, prompt, latest string, gen jsonGenerator) (string, *StreamResult, error) {
	instr := spec.instruction()
	fullPrompt := joinBlocks(prompt, instr)
	latestFull := latest
	if strings.TrimSpace(latest) != "" {
		latestFull = joinBlocks(latest, instr)
	}
	text, res, err := gen(ctx, fullPrompt, latestFull)
	if err != nil {
		return "", res, err
	}
	clean, bad := checkJSONAnswer(text, spec)
	if bad == nil {
		return clean, res, nil
	}

	// One repair round: same request, same account, same attachments. Each Google
	// call has its own 600 s dead-connection ceiling and nothing else bounds it.
	logf("[json] invalid structured answer (%s), running one repair round", bad.Error())
	repair := spec.repairInstruction(bad)
	var acct int64
	if res != nil {
		acct = res.AccountID
	}
	text2, res2, err := gen(withPreferredAccount(ctx, acct),
		joinBlocks(joinBlocks(fullPrompt, "[Assistant]: "+text), repair), repair)
	if err != nil {
		return "", res2, err
	}
	if res2 != nil && res != nil {
		res2.TotalMs += res.TotalMs
	}
	clean, bad = checkJSONAnswer(text2, spec)
	if bad != nil {
		return "", res2, newUpstreamError(ClassInvalidJSON, 200,
			"model did not return valid JSON after one repair round: %s", bad.Error())
	}
	return clean, res2, nil
}

func joinBlocks(a, b string) string {
	if strings.TrimSpace(a) == "" {
		return b
	}
	return a + "\n\n" + b
}
