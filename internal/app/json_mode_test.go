package app

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestExtractJSON(t *testing.T) {
	cases := []struct {
		name, in, root, want string
		bad                  bool
	}{
		{"plain", `{"a":1}`, jsonRootObject, `{"a":1}`, false},
		{"fenced", "```json\n{\"a\": 1}\n```", jsonRootObject, `{"a": 1}`, false},
		{"fence without lang", "```\n{\"a\":1}\n```", jsonRootObject, `{"a":1}`, false},
		{"prose around", "Sure! Here you go:\n{\"a\":{\"b\":[1,2]}}\nHope it helps.", jsonRootObject, `{"a":{"b":[1,2]}}`, false},
		{"braces in strings", `{"a":"}{ \" ]"}`, jsonRootObject, `{"a":"}{ \" ]"}`, false},
		{"fence inside a string", "{\"md\":\"```go\\nx\\n```\"}", jsonRootObject, "{\"md\":\"```go\\nx\\n```\"}", false},
		{"array root", `noise [1,{"a":2}] tail`, jsonRootArray, `[1,{"a":2}]`, false},
		{"any picks the first bracket", `x [1] {"a":1}`, jsonRootAny, `[1]`, false},
		{"any picks the first brace", `x {"a":1} [1]`, jsonRootAny, `{"a":1}`, false},
		{"no object", "just words", jsonRootObject, "", true},
		{"truncated", `{"a":[1,2`, jsonRootObject, "", true},
		{"array when object wanted", `[1,2]`, jsonRootObject, "", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, p := extractJSON(c.in, c.root)
			if c.bad {
				if p == nil {
					t.Fatalf("want a problem, got %q", got)
				}
				return
			}
			if p != nil || got != c.want {
				t.Fatalf("got %q (%v), want %q", got, p, c.want)
			}
		})
	}
}

func mustSpec(t *testing.T, schemaJSON string, strict bool) *jsonSpec {
	t.Helper()
	var schema interface{}
	if err := json.Unmarshal([]byte(schemaJSON), &schema); err != nil {
		t.Fatalf("bad test schema: %v", err)
	}
	spec, err := newJSONSpec(schema, strict, "t")
	if err != nil {
		t.Fatalf("newJSONSpec: %v", err)
	}
	return spec
}

func TestSchemaValidation(t *testing.T) {
	const article = `{
		"type":"object",
		"properties":{
			"title":{"type":"string","minLength":1},
			"lang":{"type":"string","enum":["en","az"]},
			"score":{"type":"integer","minimum":0,"maximum":10},
			"tags":{"type":"array","items":{"type":"string"},"minItems":1,"maxItems":3},
			"author":{"type":["string","null"]},
			"meta":{"type":"object","properties":{"id":{"type":"number"}},"required":["id"],"additionalProperties":false},
			"kind":{"anyOf":[{"type":"string","enum":["news"]},{"type":"null"}]},
			"ref":{"$ref":"#/$defs/url"}
		},
		"required":["title","lang"],
		"additionalProperties":false,
		"$defs":{"url":{"type":"string","minLength":4}}
	}`
	spec := mustSpec(t, article, true)
	cases := []struct {
		name, in string
		wantBad  string // substring of the problem; "" = valid
	}{
		{"minimal", `{"title":"t","lang":"en"}`, ""},
		{"full", `{"title":"t","lang":"az","score":10,"tags":["a"],"author":null,"meta":{"id":1.5},"kind":null,"ref":"http"}`, ""},
		{"missing required", `{"title":"t"}`, `missing required property "lang"`},
		{"wrong type", `{"title":5,"lang":"en"}`, "$.title: expected string, got number"},
		{"enum", `{"title":"t","lang":"de"}`, "$.lang: value is not one of the allowed enum values"},
		{"integer wants whole", `{"title":"t","lang":"en","score":1.5}`, "$.score: expected integer"},
		{"integer accepts 3.0", `{"title":"t","lang":"en","score":3.0}`, ""},
		{"maximum", `{"title":"t","lang":"en","score":11}`, "above the maximum"},
		{"array items", `{"title":"t","lang":"en","tags":["a",2]}`, "$.tags[1]: expected string, got number"},
		{"minItems", `{"title":"t","lang":"en","tags":[]}`, "fewer than 1 items"},
		{"maxItems", `{"title":"t","lang":"en","tags":["a","b","c","d"]}`, "more than 3 items"},
		{"null where not allowed", `{"title":null,"lang":"en"}`, "$.title: expected string, got null"},
		{"extra property", `{"title":"t","lang":"en","extra":1}`, "unexpected property"},
		{"nested required", `{"title":"t","lang":"en","meta":{}}`, `$.meta: missing required property "id"`},
		{"nested extra", `{"title":"t","lang":"en","meta":{"id":1,"x":2}}`, "$.meta: unexpected property"},
		{"anyOf miss", `{"title":"t","lang":"en","kind":"blog"}`, "$.kind: does not match any"},
		{"ref", `{"title":"t","lang":"en","ref":"x"}`, "$.ref: string is shorter than 4"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			clean, p := checkJSONAnswer(c.in, spec)
			if c.wantBad == "" {
				if p != nil {
					t.Fatalf("unexpected problem: %v", p.Repair())
				}
				if clean == "" {
					t.Fatal("no clean text")
				}
				return
			}
			if p == nil {
				t.Fatalf("want problem containing %q, got none", c.wantBad)
			}
			if !strings.Contains(p.Repair(), c.wantBad) {
				t.Errorf("problem %q lacks %q", p.Repair(), c.wantBad)
			}
		})
	}
}

// The public form of a problem names a location and a rule, never a value.
func TestProblemPublicFormHidesValues(t *testing.T) {
	spec := mustSpec(t, `{"type":"object","properties":{"lang":{"enum":["en"]}},"additionalProperties":false}`, true)
	for _, in := range []string{`{"lang":"secret-value"}`, `{"leaked-key":1}`} {
		_, p := checkJSONAnswer(in, spec)
		if p == nil {
			t.Fatalf("%s should fail", in)
		}
		if strings.Contains(p.Error(), "secret-value") || strings.Contains(p.Error(), "leaked-key") {
			t.Errorf("public problem leaks a value: %q", p.Error())
		}
	}
	_, p := checkJSONAnswer(`{"leaked-key":1}`, spec)
	if !strings.Contains(p.Repair(), "leaked-key") {
		t.Errorf("repair text should name the offending key: %q", p.Repair())
	}
}

func TestSyntaxErrorReported(t *testing.T) {
	spec := &jsonSpec{Root: jsonRootObject}
	_, p := checkJSONAnswer(`{"a":1,}`, spec)
	if p == nil || !strings.Contains(p.Error(), "not valid JSON") {
		t.Fatalf("trailing comma should be a syntax problem, got %v", p)
	}
}

// Gemini's OpenAPI-style responseSchema is converted to the validator form.
func TestNormalizeGeminiSchema(t *testing.T) {
	var gem interface{}
	if err := json.Unmarshal([]byte(`{
		"type":"OBJECT",
		"properties":{
			"headline":{"type":"STRING"},
			"summary":{"type":"STRING","nullable":true},
			"items":{"type":"ARRAY","items":{"type":"OBJECT","properties":{"n":{"type":"INTEGER"}},"required":["n"]}}
		},
		"required":["headline"],
		"propertyOrdering":["headline","summary","items"]
	}`), &gem); err != nil {
		t.Fatal(err)
	}
	spec, err := newJSONSpec(gem, false, "")
	if err != nil {
		t.Fatal(err)
	}
	if spec.Root != jsonRootObject {
		t.Errorf("root = %s", spec.Root)
	}
	if _, has := spec.Schema["propertyOrdering"]; has {
		t.Error("propertyOrdering should be dropped")
	}
	props := spec.Schema["properties"].(map[string]interface{})
	if props["headline"].(map[string]interface{})["type"] != "string" {
		t.Errorf("types should be lower-cased: %v", props["headline"])
	}
	if types := schemaTypes(props["summary"].(map[string]interface{})); len(types) != 2 || types[1] != "null" {
		t.Errorf("nullable should become a null type: %v", types)
	}
	for in, ok := range map[string]bool{
		`{"headline":"h","summary":null,"items":[{"n":1}]}`: true,
		`{"headline":"h"}`:                         true,
		`{"summary":"s"}`:                          false,
		`{"headline":"h","items":[{"n":"x"}]}`:     false,
		`{"headline":"h","items":[{"n":1.5}]}`:     false,
		`{"headline":"h","summary":5}`:             false,
		`{"headline":"h","items":[{"n":1}],"z":1}`: true, // additionalProperties unset: allowed
	} {
		if _, p := checkJSONAnswer(in, spec); (p == nil) != ok {
			t.Errorf("%s: valid=%v, want %v (%v)", in, p == nil, ok, p)
		}
	}

	// An array-typed schema makes the root an array.
	var arr interface{}
	_ = json.Unmarshal([]byte(`{"type":"ARRAY","items":{"type":"STRING"}}`), &arr)
	aspec, err := newJSONSpec(arr, false, "")
	if err != nil || aspec.Root != jsonRootArray {
		t.Fatalf("array root: %v %v", aspec, err)
	}
	if _, p := checkJSONAnswer("```json\n[\"a\",\"b\"]\n```", aspec); p != nil {
		t.Errorf("array answer rejected: %v", p)
	}
	if _, err := newJSONSpec(map[string]interface{}{"type": "string"}, false, ""); err == nil {
		t.Error("a string root schema should be refused")
	}
}

func TestJSONSpecFromRequests(t *testing.T) {
	parse := func(s string) map[string]interface{} {
		var m map[string]interface{}
		if err := json.Unmarshal([]byte(s), &m); err != nil {
			t.Fatal(err)
		}
		return m
	}
	// chat
	if spec, err := jsonSpecFromChat(parse(`{"response_format":{"type":"text"}}`)); spec != nil || err != nil {
		t.Errorf("text format: %v %v", spec, err)
	}
	if spec, err := jsonSpecFromChat(parse(`{}`)); spec != nil || err != nil {
		t.Errorf("no format: %v %v", spec, err)
	}
	spec, err := jsonSpecFromChat(parse(`{"response_format":{"type":"json_object"}}`))
	if err != nil || spec == nil || spec.Schema != nil || spec.Root != jsonRootObject {
		t.Errorf("json_object: %v %v", spec, err)
	}
	spec, err = jsonSpecFromChat(parse(`{"response_format":{"type":"json_schema","json_schema":{"name":"x","strict":true,"schema":{"type":"object","properties":{"a":{"type":"string"}},"required":["a"],"additionalProperties":false}}}}`))
	if err != nil || spec == nil || !spec.Strict || spec.Name != "x" || spec.Schema == nil {
		t.Errorf("json_schema: %v %v", spec, err)
	}
	if _, err := jsonSpecFromChat(parse(`{"response_format":{"type":"json_schema","json_schema":{"name":"x"}}}`)); err == nil {
		t.Error("json_schema without a schema must be refused")
	}
	if _, err := jsonSpecFromChat(parse(`{"response_format":{"type":"xml"}}`)); err == nil {
		t.Error("unknown format type must be refused")
	}
	// responses
	spec, err = jsonSpecFromResponses(parse(`{"text":{"format":{"type":"json_schema","name":"r","strict":true,"schema":{"type":"object"}}}}`))
	if err != nil || spec == nil || spec.Name != "r" || !spec.Strict {
		t.Errorf("responses json_schema: %v %v", spec, err)
	}
	if spec, err = jsonSpecFromResponses(parse(`{"text":{"format":{"type":"json_object"}}}`)); err != nil || spec == nil {
		t.Errorf("responses json_object: %v %v", spec, err)
	}
	if spec, err = jsonSpecFromResponses(parse(`{"input":"x"}`)); spec != nil || err != nil {
		t.Errorf("responses without text: %v %v", spec, err)
	}
}

func TestJSONInstruction(t *testing.T) {
	spec := mustSpec(t, `{"type":"object","properties":{"a":{"type":"string"}}}`, true)
	ins := spec.instruction()
	for _, want := range []string{"exactly one JSON object", "No markdown code fences", `"properties"`, "Strict:"} {
		if !strings.Contains(ins, want) {
			t.Errorf("instruction lacks %q:\n%s", want, ins)
		}
	}
	if plain := (&jsonSpec{Root: jsonRootObject}).instruction(); strings.Contains(plain, "Schema") {
		t.Errorf("json_object mode carries no schema: %s", plain)
	}
}
