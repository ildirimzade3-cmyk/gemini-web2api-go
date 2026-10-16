package app

// Web-rendering artifacts in answers.
//
// The answer text comes from Google's web app, which renders markdown: a URL
// inside the model's text comes back as an auto-link, `[https://x.io/a](https://x.io/a)`
// (or `<https://x.io/a>`), and in JSON mode the model's plain characters can come
// back markdown-escaped (`snake\_case`). Both corrupt string fields of JSON
// answers. This file holds the cleanups:
//
//   - unwrapAutoLinks (every answer, applied by cleanGeminiText and to browser
//     fallback text): a link whose label is its own target, or an <http(s)://...>
//     autolink, becomes the bare URL. Links with a different label are real
//     markdown and are never touched.
//   - pendingTailStart: a streamed cumulative frame may end in the middle of such
//     a link; the unfinished part is held back so the prefix diff stays valid.
//   - fixInvalidJSONEscapes / rewriteJSONStrings (JSON mode only): drop the
//     backslash of markdown escapes that are not valid JSON escapes, and unwrap a
//     string value that is exactly a self-referencing markdown link.

import (
	"encoding/json"
	"strings"
	"unicode/utf8"
)

// maxLinkLen bounds how far a link is searched for, so a stray '[' in a long text
// costs nothing and never holds a stream back for long.
const maxLinkLen = 2048

func isASCIIPunct(c byte) bool {
	return c > 32 && c < 127 && !(c >= '0' && c <= '9') && !(c >= 'a' && c <= 'z') && !(c >= 'A' && c <= 'Z')
}

// unescapeMarkdown drops the backslash of markdown escapes (a backslash before
// an ASCII punctuation character).
func unescapeMarkdown(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+1 < len(s) && isASCIIPunct(s[i+1]) {
			i++
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

// parseInlineLink parses a markdown inline link `[label](target)` starting at
// s[i] == '['. The label has no nested '[' and no line break; the target has no
// whitespace and may contain balanced parentheses. A title (`(url "t")`) is not
// a plain link. It returns the raw label, the raw target and the index after the
// closing ')'.
func parseInlineLink(s string, i int) (label, target string, end int, ok bool) {
	limit := len(s)
	if limit-i > maxLinkLen {
		limit = i + maxLinkLen
	}
	j := i + 1
	for ; j < limit; j++ {
		switch s[j] {
		case '\\':
			j++
			continue
		case '[', '\n':
			return "", "", 0, false
		}
		if s[j] == ']' {
			break
		}
	}
	if j >= limit || s[j] != ']' || j+1 >= limit || s[j+1] != '(' {
		return "", "", 0, false
	}
	k, depth := j+2, 1
	for ; k < limit; k++ {
		switch c := s[k]; {
		case c == '\\':
			k++
		case c == ' ' || c == '\t' || c == '\n' || c == '<':
			return "", "", 0, false
		case c == '(':
			depth++
		case c == ')':
			depth--
		}
		if depth == 0 {
			return s[i+1 : j], s[j+2 : k], k + 1, true
		}
	}
	return "", "", 0, false
}

func stripURLScheme(u string) string {
	for _, p := range []string{"https://", "http://"} {
		if strings.HasPrefix(u, p) {
			return u[len(p):]
		}
	}
	return u
}

// selfLink reports whether label and target name the same http(s) URL: equal after
// removing markdown escapes, an optional scheme on the label and trailing slashes.
func selfLink(label, target string) bool {
	label, target = unescapeMarkdown(strings.TrimSpace(label)), unescapeMarkdown(target)
	if !strings.HasPrefix(target, "http://") && !strings.HasPrefix(target, "https://") {
		return false
	}
	l, t := strings.TrimRight(stripURLScheme(label), "/"), strings.TrimRight(stripURLScheme(target), "/")
	return l != "" && l == t
}

// autolinkEnd returns the index after the '>' of an `<http(s)://...>` autolink at
// s[i] == '<', or -1.
func autolinkEnd(s string, i int) int {
	rest := s[i+1:]
	if !strings.HasPrefix(rest, "http://") && !strings.HasPrefix(rest, "https://") {
		return -1
	}
	if len(rest) > maxLinkLen {
		rest = rest[:maxLinkLen]
	}
	for k := 0; k < len(rest); k++ {
		switch rest[k] {
		case '>':
			return i + 1 + k + 1
		case ' ', '\t', '\n', '<':
			return -1
		}
	}
	return -1
}

// unwrapAutoLinks replaces self-referencing markdown links and <http(s)://...>
// autolinks by the URL text. The label (what the model wrote) is kept, without
// markdown escapes. Everything else, including links with a different label and
// images, is left alone.
func unwrapAutoLinks(s string) string {
	if !strings.ContainsAny(s, "[<") {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); {
		switch s[i] {
		case '[':
			if i == 0 || s[i-1] != '!' {
				if label, target, end, ok := parseInlineLink(s, i); ok && selfLink(label, target) {
					b.WriteString(unescapeMarkdown(strings.TrimSpace(label)))
					i = end
					continue
				}
			}
		case '<':
			if end := autolinkEnd(s, i); end > 0 {
				b.WriteString(s[i+1 : end-1])
				i = end
				continue
			}
		}
		b.WriteByte(s[i])
		i++
	}
	return b.String()
}

// pendingTailStart returns where an unfinished link construct at the end of a
// cumulative stream frame begins (len(s) when there is none). Such a tail may
// still turn into a bare URL, so it is not sent yet; the final text carries it.
func pendingTailStart(s string) int {
	pending := len(s)
	if i := strings.LastIndexByte(s, '['); i >= 0 && len(s)-i <= maxLinkLen && !strings.Contains(s[i:], "\n") {
		if linkPending(s[i:]) {
			pending = i
		}
	}
	if i := strings.LastIndexByte(s, '<'); i >= 0 && i < pending && len(s)-i <= maxLinkLen {
		tail := s[i:]
		if !strings.ContainsAny(tail, " \t\n>") &&
			(strings.HasPrefix("<https://", tail) || strings.HasPrefix("<http://", tail) ||
				strings.HasPrefix(tail, "<https://") || strings.HasPrefix(tail, "<http://")) {
			pending = i
		}
	}
	return pending
}

// linkPending: tail starts at the last '['. True while it could still become a
// complete inline link.
func linkPending(tail string) bool {
	j := 1
	for ; j < len(tail); j++ {
		if tail[j] == '\\' {
			j++
			continue
		}
		if tail[j] == ']' {
			break
		}
	}
	if j >= len(tail) {
		return true // label not closed yet
	}
	if j == len(tail)-1 {
		return true // "]" may be followed by "("
	}
	if tail[j+1] != '(' {
		return false
	}
	depth := 1
	for k := j + 2; k < len(tail); k++ {
		switch c := tail[k]; {
		case c == '\\':
			k++
		case c == ' ' || c == '\t' || c == '\n' || c == '<':
			return false // not a plain link, nothing will be rewritten
		case c == '(':
			depth++
		case c == ')':
			depth--
			if depth == 0 {
				return false
			}
		}
	}
	return true
}

// fixInvalidJSONEscapes removes the backslash of markdown escapes inside JSON
// string literals where it is not a valid JSON escape (`\_`, `\*`, `\#`, ...). Valid
// escapes (`\" \\ \/ \b \f \n \r \t \uXXXX`) and everything outside strings stay.
func fixInvalidJSONEscapes(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	inStr := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !inStr {
			if c == '"' {
				inStr = true
			}
			b.WriteByte(c)
			continue
		}
		switch {
		case c == '"':
			inStr = false
		case c == '\\' && i+1 < len(s):
			n := s[i+1]
			if isASCIIPunct(n) && n != '"' && n != '\\' && n != '/' {
				continue // drop the backslash, the next iteration writes the character
			}
			b.WriteByte(c)
			b.WriteByte(n)
			i++
			continue
		}
		b.WriteByte(c)
	}
	return b.String()
}

// rewriteJSONStrings applies fn to the decoded value of every string literal in a
// JSON text and writes back the ones it changes; order and layout stay. Text that
// is not valid JSON in places is passed through unchanged there.
func rewriteJSONStrings(s string, fn func(string) (string, bool)) string {
	if !strings.Contains(s, `"`) {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); {
		if s[i] != '"' {
			b.WriteByte(s[i])
			i++
			continue
		}
		j := i + 1
		for j < len(s) && s[j] != '"' {
			if s[j] == '\\' {
				j++
			}
			j++
		}
		if j >= len(s) {
			b.WriteString(s[i:])
			break
		}
		lit := s[i : j+1]
		var v string
		if err := json.Unmarshal([]byte(lit), &v); err == nil && utf8.ValidString(v) {
			if nv, changed := fn(v); changed {
				lit = encodeJSONString(nv)
			}
		}
		b.WriteString(lit)
		i = j + 1
	}
	return b.String()
}

func encodeJSONString(v string) string {
	var sb strings.Builder
	enc := json.NewEncoder(&sb)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
	return strings.TrimSuffix(sb.String(), "\n")
}

// unwrapExactLink turns a string value that is exactly `[label](url)` with
// label == url into the URL.
func unwrapExactLink(v string) (string, bool) {
	t := strings.TrimSpace(v)
	if !strings.HasPrefix(t, "[") {
		return v, false
	}
	label, target, end, ok := parseInlineLink(t, 0)
	if !ok || end != len(t) || !selfLink(label, target) {
		return v, false
	}
	return unescapeMarkdown(strings.TrimSpace(label)), true
}
