package host

import (
	"errors"
	"fmt"
	"maps"
	"math"
	"slices"
	"strings"
)

type propSpec struct {
	kinds      []string
	nullable   bool
	enumValues []any
}

type methodParams struct {
	required             []string
	properties           map[string]propSpec
	additionalProperties bool
}

type methodEntry struct {
	params methodParams
	denied string
}

type focusPolicy struct {
	kind   string
	field  string
	fields [2]string
}

type resultVariant struct {
	Type  string
	Paths []string
}

func present(params map[string]any, key string) bool {
	v := params[key]
	return v != nil && v != ""
}

func explicit(method, detail string) string {
	return method + ": " + detail + " — raw herdr calls never fall back to live herdr focus"
}

func runtimeKind(v any) string {
	switch t := v.(type) {
	case nil:
		return "null"
	case string:
		return "string"
	case bool:
		return "boolean"
	case int:
		return "integer"
	case int64:
		return "integer"
	case float64:
		if t == math.Trunc(t) && !math.IsInf(t, 0) {
			return "integer"
		}
		return "number"
	case []any:
		return "array"
	default:
		return "object"
	}
}

func kindsMatch(spec propSpec, v any) bool {
	if v == nil {
		return spec.nullable
	}
	kind := runtimeKind(v)
	if kind == "null" {
		return false
	}
	if slices.Contains(spec.kinds, kind) {
		return true
	}
	if kind == "integer" && slices.Contains(spec.kinds, "number") {
		return true
	}
	return kind == "number" && slices.Contains(spec.kinds, "integer") && isIntegral(v)
}

func isIntegral(v any) bool {
	f, ok := v.(float64)
	return ok && f == math.Trunc(f)
}

// validateMethodParams reports an unknown or denied method, or params that
// violate the generated schema. Empty string means valid.
func validateMethodParams(method string, params map[string]any, isWholeTemplate func(string) bool) string {
	entry, ok := herdrMethods[method]
	if !ok {
		return fmt.Sprintf("unknown herdr method '%s'", method)
	}
	if entry.denied != "" {
		return method + ": " + entry.denied
	}
	obj := params
	if obj == nil {
		obj = map[string]any{}
	}
	for _, key := range entry.params.required {
		if v, ok := obj[key]; !ok || v == nil {
			return fmt.Sprintf("%s: missing required param '%s'", method, key)
		}
	}
	for _, key := range slices.Sorted(maps.Keys(obj)) {
		value := obj[key]
		prop, ok := entry.params.properties[key]
		if !ok {
			if !entry.params.additionalProperties {
				return fmt.Sprintf("%s: unknown param '%s'", method, key)
			}
			continue
		}
		// Whole-value templates defer parameter shape checks until substitution.
		if text, isString := value.(string); isString && isWholeTemplate != nil && isWholeTemplate(text) {
			continue
		}
		if len(prop.enumValues) > 0 && !slices.Contains(prop.enumValues, value) && (value != nil || !prop.nullable) {
			return fmt.Sprintf("%s: param '%s' must be one of %s", method, key, joinEnumValues(prop.enumValues))
		}
		if !kindsMatch(prop, value) {
			kinds := prop.kinds
			if prop.nullable {
				kinds = append(slices.Clone(kinds), "null")
			}
			return fmt.Sprintf("%s: param '%s' expects %s", method, key, strings.Join(kinds, "|"))
		}
	}
	return ""
}

func joinEnumValues(values []any) string {
	parts := make([]string, len(values))
	for i, v := range values {
		parts[i] = fmt.Sprint(v)
	}
	return strings.Join(parts, ", ")
}

func swapPolicy(method string, params map[string]any) string {
	direction := present(params, "direction") && present(params, "pane_id")
	pair := present(params, "source_pane_id") && present(params, "target_pane_id")
	if direction || pair {
		return ""
	}
	return explicit(method, "needs direction with pane_id, or both source_pane_id and target_pane_id")
}

func movePolicy(method string, params map[string]any) string {
	dest, ok := params["destination"].(map[string]any)
	if !ok {
		return method + ": destination must be an object"
	}
	if dest["type"] == "tab" && !present(dest, "target_pane_id") {
		return explicit(method, "destination type 'tab' needs destination.target_pane_id")
	}
	if dest["type"] == "new_tab" && !present(dest, "workspace_id") {
		return explicit(method, "destination type 'new_tab' needs destination.workspace_id")
	}
	return ""
}

// assertFocusPolicy enforces the explicit-target policy: omitted selectors
// must never reach live UI focus. Classification comes from the generated
// table; an unclassified method is rejected.
func assertFocusPolicy(method string, params map[string]any) string {
	policy, ok := herdrFocusPolicy[method]
	if !ok {
		return explicit(method, "needs an explicit target selector (unclassified method)")
	}
	switch policy.kind {
	case "none", "filter":
		return ""
	case "require":
		if !present(params, policy.field) {
			return explicit(method, "params."+policy.field+" is required")
		}
	case "exactlyOne":
		count := 0
		for _, f := range policy.fields {
			if present(params, f) {
				count++
			}
		}
		if count != 1 {
			return explicit(method, fmt.Sprintf("needs exactly one of %s or %s",
				policy.fields[0], policy.fields[1]))
		}
	case "atLeastOne":
		if !present(params, policy.fields[0]) && !present(params, policy.fields[1]) {
			return explicit(method, fmt.Sprintf("needs one of %s or %s",
				policy.fields[0], policy.fields[1]))
		}
	case "swap":
		return swapPolicy(method, params)
	case "move":
		return movePolicy(method, params)
	}
	return ""
}

// ValidateHerdrInvocation applies schema params then the explicit-target
// policy — the shared load-time and runtime gate for a raw `herdr:` action.
func ValidateHerdrInvocation(method string, params map[string]any, isWholeTemplate func(string) bool) error {
	if msg := validateMethodParams(method, params, isWholeTemplate); msg != "" {
		return errors.New(msg)
	}
	if msg := assertFocusPolicy(method, params); msg != "" {
		return errors.New(msg)
	}
	return nil
}

// MethodDeniedReason reports the invariant a denied method protects.
func MethodDeniedReason(method string) (string, bool) {
	entry, ok := herdrMethods[method]
	if !ok || entry.denied == "" {
		return "", false
	}
	return entry.denied, true
}
