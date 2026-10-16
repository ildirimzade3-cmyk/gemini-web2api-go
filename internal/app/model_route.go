package app

// Model and thinking mapping for the OpenAI routes and the Gemini-native
// /v1beta routes. The table below is the single place that says which ids are
// accepted and how a thinking request picks the "-thinking" variant.
//
//	request                                              served model
//	---------------------------------------------------  --------------------------------
//	<id>, models/<id>                                    <id>
//	<id> + thinkingLevel HIGH or MEDIUM                  <id>-thinking
//	<id> + thinkingBudget > 0                            <id>-thinking
//	<id> + reasoning_effort / reasoning.effort high|medium  <id>-thinking
//	<id> + LOW / MINIMAL / budget 0 / budget -1 / absent  <id>
//	<id>-thinking (any thinking setting)                 <id>-thinking
//
// <id> is one of the family ids below, or one of its aliases (the alias keeps
// its own name: gemini-3.7-flash -> gemini-3.7-flash-thinking, same hex as
// gemini-3.8-flash). Media models (gemini-image, ...) are reachable on the OpenAI
// routes by their own names only; a thinking request does not touch them.

import (
	"sort"
	"strings"
)

const thinkingSuffix = "-thinking"

// Nominal numbers reported by GET /v1beta/models. They are Google's published
// limits for this model generation, advisory only: the bridge enforces
// max_prompt_bytes (an upstream byte wall) and never cuts output.
const (
	nominalInputTokenLimit  = 1048576
	nominalOutputTokenLimit = 65536
)

// modelFamily is one real upstream model. The plain model is ID; its extended
// thinking sibling is ID + thinkingSuffix (both must exist in Models).
type modelFamily struct {
	ID      string
	Aliases []string
	Display string
}

var modelFamilies = []modelFamily{
	{ID: "gemini-3.6-flash", Display: "Gemini 3.6 Flash"},
	{ID: "gemini-3.5-flash-lite", Display: "Gemini 3.5 Flash-Lite"},
	{ID: "gemini-3.1-pro", Display: "Gemini 3.1 Pro"},
	{ID: "gemini-3.8-flash", Aliases: []string{"gemini-3.7-flash"}, Display: "Gemini 3.8 Flash"},
	{ID: "gemini-4-argon", Display: "Gemini 4 Argon"},
}

// familyOf finds the family of an id (plain, alias or "-thinking" variant of
// either). thinking reports whether the id already names the thinking variant.
func familyOf(id string) (fam modelFamily, thinking bool, ok bool) {
	base := id
	if strings.HasSuffix(id, thinkingSuffix) {
		base, thinking = strings.TrimSuffix(id, thinkingSuffix), true
	}
	for _, f := range modelFamilies {
		if f.ID == base {
			return f, thinking, true
		}
		for _, a := range f.Aliases {
			if a == base {
				return f, thinking, true
			}
		}
	}
	return modelFamily{}, false, false
}

// cleanModelID normalises a requested model id: surrounding space, the Gemini
// "models/" prefix and the legacy "@think=N" suffix are dropped.
func cleanModelID(requested string) string {
	name := strings.TrimPrefix(strings.TrimSpace(requested), "models/")
	if i := strings.Index(name, "@think="); i >= 0 {
		name = name[:i]
	}
	return name
}

// routeModel resolves a requested id for the OpenAI routes. wantThinking asks
// for the extended-thinking variant of a family model; ids outside the families
// (media models) are resolved as they are.
func routeModel(requested string, wantThinking bool) (string, ModelConfig, error) {
	name := cleanModelID(requested)
	if _, thinking, ok := familyOf(name); ok && wantThinking && !thinking {
		name += thinkingSuffix
	}
	return resolveModel(name)
}

// routeFamilyModel is routeModel for the Gemini routes, which serve the family
// models only: anything else is an unknown model (404).
func routeFamilyModel(requested string, wantThinking bool) (string, ModelConfig, error) {
	if _, _, ok := familyOf(cleanModelID(requested)); !ok {
		return "", ModelConfig{}, &unknownModelError{Name: cleanModelID(requested)}
	}
	return routeModel(requested, wantThinking)
}

// thinkingFromEffort maps OpenAI reasoning effort (chat reasoning_effort,
// Responses reasoning.effort) to "use the thinking variant".
func thinkingFromEffort(effort string) bool {
	switch strings.ToLower(strings.TrimSpace(effort)) {
	case "high", "medium":
		return true
	}
	return false
}

// thinkingFromGemini maps generationConfig.thinkingConfig. The level wins over
// the budget when both are present.
func thinkingFromGemini(level string, budget *float64) bool {
	if level = strings.ToUpper(strings.TrimSpace(level)); level != "" {
		return level == "HIGH" || level == "MEDIUM"
	}
	return budget != nil && *budget > 0
}

// listedModel is one entry of the model listings.
type listedModel struct {
	ID       string
	Display  string
	Thinking bool
	Base     string // plain model id for a thinking variant, else ""
}

// listedModels returns the family models that are usable right now (the
// thinking variants need a signed-in cookie, see availableModels), plain model
// first, then its thinking variant. Aliases are accepted but not listed.
func listedModels() []listedModel {
	avail := availableModels()
	var out []listedModel
	for _, f := range modelFamilies {
		if _, ok := avail[f.ID]; ok {
			out = append(out, listedModel{ID: f.ID, Display: f.Display})
		}
		if _, ok := avail[f.ID+thinkingSuffix]; ok {
			out = append(out, listedModel{
				ID: f.ID + thinkingSuffix, Display: f.Display + " (extended thinking)",
				Thinking: true, Base: f.ID,
			})
		}
	}
	return out
}

// thinkingVariantOf returns the thinking sibling id of a plain model id, "" when
// the id is not a plain family model.
func thinkingVariantOf(id string) string {
	if _, thinking, ok := familyOf(id); ok && !thinking {
		return id + thinkingSuffix
	}
	return ""
}

// sortedModelNames lists the ids of availableModels in a stable order.
func sortedModelNames() []string {
	var names []string
	for n := range availableModels() {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}
