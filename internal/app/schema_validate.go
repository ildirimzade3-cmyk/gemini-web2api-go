package app

// A practical JSON Schema subset, enough to check the structured output of the
// model: type (incl. unions and nullable), properties, required,
// additionalProperties, enum, const, items, anyOf/oneOf/allOf, local $ref,
// minItems/maxItems, minLength/maxLength and minimum/maximum. Everything else
// (pattern, format, uniqueItems, ...) is not enforced. Gemini's OpenAPI-style
// responseSchema (upper-case types, nullable) goes through normalizeSchema first.

import (
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// jsonProblem is a validation failure. Error() is safe to show a client and to
// store (it names a location and a rule, never a value); Repair() adds the
// offending key name and is only sent back to the model in the repair round.
type jsonProblem struct {
	Path   string
	Reason string
	Detail string
}

func (p *jsonProblem) Error() string { return p.Path + ": " + p.Reason }

func (p *jsonProblem) Repair() string {
	if p.Detail == "" {
		return p.Error()
	}
	return p.Error() + " (" + p.Detail + ")"
}

func problem(path, reason string) *jsonProblem { return &jsonProblem{Path: path, Reason: reason} }

// normalizeSchema converts an OpenAPI/Gemini schema node into the plain JSON
// Schema form the validator and the prompt use: lower-case type names,
// nullable:true -> a "null" entry in type, propertyOrdering and friends dropped.
// Plain JSON Schema passes through unchanged. The input is not modified.
func normalizeSchema(v interface{}) interface{} {
	m, ok := v.(map[string]interface{})
	if !ok {
		return v
	}
	out := make(map[string]interface{}, len(m))
	nullable := false
	for k, val := range m {
		switch k {
		case "propertyOrdering", "minProperties", "maxProperties":
			// Gemini-only hints; not part of what we enforce.
		case "nullable":
			nullable, _ = val.(bool)
		case "type":
			if t := normalizeType(val); t != nil {
				out[k] = t
			}
		case "properties", "$defs", "definitions":
			if sub, ok := val.(map[string]interface{}); ok {
				ns := make(map[string]interface{}, len(sub))
				for name, node := range sub {
					ns[name] = normalizeSchema(node)
				}
				out[k] = ns
			} else {
				out[k] = val
			}
		case "items", "additionalProperties", "not":
			out[k] = normalizeSchema(val)
		case "anyOf", "oneOf", "allOf":
			if list, ok := val.([]interface{}); ok {
				nl := make([]interface{}, len(list))
				for i, node := range list {
					nl[i] = normalizeSchema(node)
				}
				out[k] = nl
			} else {
				out[k] = val
			}
		default:
			out[k] = val
		}
	}
	if nullable {
		if t, ok := out["type"]; ok {
			out["type"] = withNullType(t)
		}
	}
	return out
}

func normalizeType(v interface{}) interface{} {
	switch t := v.(type) {
	case string:
		t = strings.ToLower(t)
		if t == "type_unspecified" {
			return nil
		}
		return t
	case []interface{}:
		out := make([]interface{}, 0, len(t))
		for _, e := range t {
			if s, ok := e.(string); ok {
				out = append(out, strings.ToLower(s))
			}
		}
		return out
	}
	return nil
}

func withNullType(t interface{}) interface{} {
	switch x := t.(type) {
	case string:
		if x == "null" {
			return x
		}
		return []interface{}{x, "null"}
	case []interface{}:
		for _, e := range x {
			if e == "null" {
				return x
			}
		}
		return append(append([]interface{}{}, x...), "null")
	}
	return t
}

// validateJSON checks a decoded value (numbers as json.Number) against a
// normalised root schema. nil means valid.
func validateJSON(root map[string]interface{}, val interface{}) *jsonProblem {
	v := &schemaValidator{root: root}
	return v.check(root, val, "$", 0)
}

type schemaValidator struct{ root map[string]interface{} }

const maxSchemaDepth = 64

func (v *schemaValidator) check(schema, val interface{}, path string, depth int) *jsonProblem {
	if depth > maxSchemaDepth {
		return problem(path, "schema nesting is too deep to validate")
	}
	switch s := schema.(type) {
	case bool:
		if !s {
			return problem(path, "no value is allowed here")
		}
		return nil
	case map[string]interface{}:
		return v.checkNode(s, val, path, depth)
	}
	return nil
}

func (v *schemaValidator) checkNode(s map[string]interface{}, val interface{}, path string, depth int) *jsonProblem {
	if ref, ok := s["$ref"].(string); ok {
		target, ok := v.resolve(ref)
		if !ok {
			return nil // an unresolvable reference is not enforced
		}
		return v.check(target, val, path, depth+1)
	}
	if list, ok := s["allOf"].([]interface{}); ok {
		for _, sub := range list {
			if p := v.check(sub, val, path, depth+1); p != nil {
				return p
			}
		}
	}
	for _, key := range []string{"anyOf", "oneOf"} {
		list, ok := s[key].([]interface{})
		if !ok || len(list) == 0 {
			continue
		}
		var first *jsonProblem
		matched := false
		for _, sub := range list {
			p := v.check(sub, val, path, depth+1)
			if p == nil {
				matched = true
				break
			}
			if first == nil {
				first = p
			}
		}
		if !matched {
			p := problem(path, "does not match any of the allowed alternatives")
			if first != nil {
				p.Detail = "first alternative: " + first.Repair()
			}
			return p
		}
	}

	types := schemaTypes(s)
	if val == nil {
		if len(types) == 0 || containsString(types, "null") {
			return nil
		}
		return problem(path, "expected "+strings.Join(types, " or ")+", got null")
	}
	if len(types) > 0 && !matchesAnyType(types, val) {
		return problem(path, "expected "+strings.Join(types, " or ")+", got "+jsonTypeName(val))
	}
	if enum, ok := s["enum"].([]interface{}); ok {
		found := false
		for _, e := range enum {
			if jsonEqual(e, val) {
				found = true
				break
			}
		}
		if !found {
			return problem(path, "value is not one of the allowed enum values")
		}
	}
	if c, ok := s["const"]; ok && !jsonEqual(c, val) {
		return problem(path, "value is not the required constant")
	}

	switch x := val.(type) {
	case map[string]interface{}:
		return v.checkObject(s, x, path, depth)
	case []interface{}:
		return v.checkArray(s, x, path, depth)
	case string:
		n := utf8.RuneCountInString(x)
		if m, ok := numField(s, "minLength"); ok && float64(n) < m {
			return problem(path, fmt.Sprintf("string is shorter than %d characters", int(m)))
		}
		if m, ok := numField(s, "maxLength"); ok && float64(n) > m {
			return problem(path, fmt.Sprintf("string is longer than %d characters", int(m)))
		}
	case json.Number:
		f, err := strconv.ParseFloat(string(x), 64)
		if err != nil {
			return nil
		}
		if m, ok := numField(s, "minimum"); ok && f < m {
			return problem(path, fmt.Sprintf("number is below the minimum %v", m))
		}
		if m, ok := numField(s, "maximum"); ok && f > m {
			return problem(path, fmt.Sprintf("number is above the maximum %v", m))
		}
	}
	return nil
}

func (v *schemaValidator) checkObject(s map[string]interface{}, obj map[string]interface{}, path string, depth int) *jsonProblem {
	if req, ok := s["required"].([]interface{}); ok {
		for _, r := range req {
			name, _ := r.(string)
			if name == "" {
				continue
			}
			if _, present := obj[name]; !present {
				return problem(path, "missing required property "+strconv.Quote(name))
			}
		}
	}
	props, _ := s["properties"].(map[string]interface{})
	names := make([]string, 0, len(props))
	for name := range props {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if child, present := obj[name]; present {
			if p := v.check(props[name], child, path+propPath(name), depth+1); p != nil {
				return p
			}
		}
	}
	extra, hasExtra := s["additionalProperties"]
	if !hasExtra {
		return nil
	}
	var keys []string
	for k := range obj {
		if _, declared := props[k]; !declared {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	for _, k := range keys {
		switch e := extra.(type) {
		case bool:
			if !e {
				p := problem(path, "unexpected property that the schema does not declare")
				p.Detail = "remove the property " + strconv.Quote(k)
				return p
			}
		case map[string]interface{}:
			if p := v.check(e, obj[k], path+propPath(k), depth+1); p != nil {
				return p
			}
		}
	}
	return nil
}

func (v *schemaValidator) checkArray(s map[string]interface{}, arr []interface{}, path string, depth int) *jsonProblem {
	if m, ok := numField(s, "minItems"); ok && float64(len(arr)) < m {
		return problem(path, fmt.Sprintf("array has fewer than %d items", int(m)))
	}
	if m, ok := numField(s, "maxItems"); ok && float64(len(arr)) > m {
		return problem(path, fmt.Sprintf("array has more than %d items", int(m)))
	}
	if items, ok := s["items"].(map[string]interface{}); ok {
		for i, e := range arr {
			if p := v.check(items, e, fmt.Sprintf("%s[%d]", path, i), depth+1); p != nil {
				return p
			}
		}
	}
	return nil
}

// resolve follows a local "#/$defs/x" or "#/definitions/x" reference.
func (v *schemaValidator) resolve(ref string) (interface{}, bool) {
	if ref == "#" {
		return v.root, true
	}
	if !strings.HasPrefix(ref, "#/") {
		return nil, false
	}
	var cur interface{} = v.root
	for _, seg := range strings.Split(ref[2:], "/") {
		seg = strings.NewReplacer("~1", "/", "~0", "~").Replace(seg)
		m, ok := cur.(map[string]interface{})
		if !ok {
			return nil, false
		}
		if cur, ok = m[seg]; !ok {
			return nil, false
		}
	}
	return cur, true
}

func propPath(name string) string {
	for _, r := range name {
		if !(r == '_' || r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z') {
			return "[" + strconv.Quote(name) + "]"
		}
	}
	return "." + name
}

func schemaTypes(s map[string]interface{}) []string {
	switch t := s["type"].(type) {
	case string:
		return []string{t}
	case []interface{}:
		var out []string
		for _, e := range t {
			if str, ok := e.(string); ok {
				out = append(out, str)
			}
		}
		return out
	}
	return nil
}

func matchesAnyType(types []string, val interface{}) bool {
	for _, t := range types {
		switch t {
		case "string":
			if _, ok := val.(string); ok {
				return true
			}
		case "number":
			if _, ok := val.(json.Number); ok {
				return true
			}
		case "integer":
			if n, ok := val.(json.Number); ok {
				if f, err := strconv.ParseFloat(string(n), 64); err == nil && f == float64(int64(f)) {
					return true
				}
			}
		case "boolean":
			if _, ok := val.(bool); ok {
				return true
			}
		case "object":
			if _, ok := val.(map[string]interface{}); ok {
				return true
			}
		case "array":
			if _, ok := val.([]interface{}); ok {
				return true
			}
		case "null":
			if val == nil {
				return true
			}
		}
	}
	return false
}

func jsonTypeName(val interface{}) string {
	switch val.(type) {
	case nil:
		return "null"
	case string:
		return "string"
	case json.Number:
		return "number"
	case bool:
		return "boolean"
	case map[string]interface{}:
		return "object"
	case []interface{}:
		return "array"
	}
	return "unknown"
}

// jsonEqual compares a schema literal (plain float64 numbers) with a decoded
// answer value (json.Number).
func jsonEqual(a, b interface{}) bool {
	return reflect.DeepEqual(comparableJSON(a), comparableJSON(b))
}

func comparableJSON(v interface{}) interface{} {
	switch x := v.(type) {
	case json.Number:
		f, _ := strconv.ParseFloat(string(x), 64)
		return f
	case map[string]interface{}:
		out := make(map[string]interface{}, len(x))
		for k, e := range x {
			out[k] = comparableJSON(e)
		}
		return out
	case []interface{}:
		out := make([]interface{}, len(x))
		for i, e := range x {
			out[i] = comparableJSON(e)
		}
		return out
	}
	return v
}

func numField(s map[string]interface{}, key string) (float64, bool) {
	switch n := s[key].(type) {
	case float64:
		return n, true
	case json.Number:
		f, err := strconv.ParseFloat(string(n), 64)
		return f, err == nil
	}
	return 0, false
}

func containsString(list []string, s string) bool {
	for _, e := range list {
		if e == s {
			return true
		}
	}
	return false
}
