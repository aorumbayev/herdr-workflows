package workflow

import (
	"encoding/json"
	"maps"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/aorumbayev/herdr-workflows/internal/config"
)

const templateInner = `(?:inputs|steps|context)(?:\.[a-zA-Z_][a-zA-Z0-9_]*)+`

var (
	templatePathRE = regexp.MustCompile(`^` + templateInner + `$`)
	templateRE     = regexp.MustCompile(`\{\{\s*(` + templateInner + `)\s*\}\}`)
	pathSegmentRE  = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`)
	anyMustacheRE  = regexp.MustCompile(`\{\{`)
)

// ParseTemplatePath parses an inner template path like "steps.assess.response".
func ParseTemplatePath(path string) (TemplatePath, bool) {
	trimmed := strings.TrimSpace(path)
	if !templatePathRE.MatchString(trimmed) {
		return TemplatePath{}, false
	}
	parts := strings.Split(trimmed, ".")
	segments := parts[1:]
	for _, s := range segments {
		if !pathSegmentRE.MatchString(s) {
			return TemplatePath{}, false
		}
	}
	return TemplatePath{Root: parts[0], Segments: segments}, true
}

// IsWholeValueTemplate reports whether text is exactly one template.
func IsWholeValueTemplate(text string) bool {
	_, ok := parseWholeValueTemplate(text)
	return ok
}

func parseWholeValueTemplate(text string) (TemplatePath, bool) {
	match := templateRE.FindStringSubmatch(text)
	if match == nil || match[0] != text {
		return TemplatePath{}, false
	}
	return ParseTemplatePath(match[1])
}

// TextTemplates finds every valid template reference in text, in order.
func TextTemplates(text string) []TemplatePath {
	var out []TemplatePath
	for _, m := range templateRE.FindAllStringSubmatch(text, -1) {
		if parsed, ok := ParseTemplatePath(m[1]); ok {
			out = append(out, parsed)
		}
	}
	return out
}

// malformedTemplateSnippet returns the first "{{…}}" span that is not a
// valid template, or the trailing "{{…" when unclosed.
func malformedTemplateSnippet(text string) (string, bool) {
	from := 0
	for from < len(text) {
		start := strings.Index(text[from:], "{{")
		if start == -1 {
			return "", false
		}
		start += from
		rest := text[start+2:]
		closeIdx := strings.Index(rest, "}}")
		if closeIdx == -1 {
			return text[start:], true
		}
		if _, ok := ParseTemplatePath(rest[:closeIdx]); !ok {
			return text[start : start+2+closeIdx+2], true
		}
		from = start + 2 + closeIdx + 2
	}
	return "", false
}

// WalkValueStrings visits string leaves and rebuilds nested arrays and maps.
func WalkValueStrings(value any, key string, visit func(text, key string) any) any {
	switch v := value.(type) {
	case string:
		return visit(v, key)
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = WalkValueStrings(item, key+"["+strconv.Itoa(i)+"]", visit)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(v))
		for _, k := range slices.Sorted(maps.Keys(v)) {
			item := v[k]
			out[k] = WalkValueStrings(item, key+"."+k, visit)
		}
		return out
	}
	return value
}

func resolvePath(ns TemplateNamespace, path TemplatePath) any {
	var cur any
	switch path.Root {
	case "inputs":
		cur = ns.Inputs
	case "steps":
		cur = ns.Steps
	case "context":
		cur = ns.Context
	}
	for _, seg := range path.Segments {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur = m[seg]
	}
	return cur
}

// jsNumber preserves the existing JavaScript-compatible template rendering.
func jsNumber(v float64) string {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return ""
	}
	if v == 0 {
		return "0"
	}
	var s string
	if abs := math.Abs(v); abs >= 1e-6 && abs < 1e21 {
		s = strconv.FormatFloat(v, 'f', -1, 64)
	} else {
		s = strconv.FormatFloat(v, 'e', -1, 64)
		s = strings.Replace(s, "e-0", "e-", 1)
		s = strings.Replace(s, "e+0", "e+", 1)
	}
	return s
}

func RenderScalar(value any) string {
	switch v := value.(type) {
	case nil:
		return ""
	case string:
		return v
	case bool:
		return strconv.FormatBool(v)
	case int:
		return strconv.Itoa(v)
	case int64:
		return strconv.FormatInt(v, 10)
	case float64:
		return jsNumber(v)
	case json.Number:
		if f, err := v.Float64(); err == nil {
			return jsNumber(f)
		}
		return ""
	}
	data, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	return string(data)
}

// SubstituteText renders embedded templates in text.
func SubstituteText(template string, ns TemplateNamespace) string {
	return templateRE.ReplaceAllStringFunc(template, func(match string) string {
		inner := templateRE.FindStringSubmatch(match)[1]
		parsed, ok := ParseTemplatePath(inner)
		if !ok {
			return match
		}
		return RenderScalar(resolvePath(ns, parsed))
	})
}

// SubstituteValue keeps the source type for a whole-value template and
// renders text otherwise.
func SubstituteValue(template string, ns TemplateNamespace) any {
	if parsed, ok := parseWholeValueTemplate(template); ok {
		return resolvePath(ns, parsed)
	}
	return SubstituteText(template, ns)
}

// SubstituteParams applies SubstituteValue recursively through params.
func SubstituteParams(params map[string]any, ns TemplateNamespace) map[string]any {
	if params == nil {
		return nil
	}
	out, _ := WalkValueStrings(params, "", func(text, _ string) any {
		return SubstituteValue(text, ns)
	}).(map[string]any)
	return out
}

func collectTemplatesFromValue(value any, out []TemplatePath) []TemplatePath {
	WalkValueStrings(value, "", func(text, _ string) any {
		out = append(out, TextTemplates(text)...)
		return text
	})
	return out
}

func collectPaneTemplates(pane *PaneSpec, out []TemplatePath) []TemplatePath {
	for _, text := range []string{pane.Open, pane.Anchor, pane.Workspace, pane.Name} {
		out = append(out, TextTemplates(text)...)
	}
	return out
}

func collectActionTemplates(a Action, out []TemplatePath) []TemplatePath {
	switch act := a.(type) {
	case AgentAction:
		out = append(out, TextTemplates(act.Prompt)...)
		out = append(out, TextTemplates(act.Using)...)
		out = append(out, TextTemplates(act.Target)...)
		out = append(out, TextTemplates(act.Cwd)...)
		for _, value := range act.Env {
			out = append(out, TextTemplates(value)...)
		}
		if act.Pane != nil {
			out = collectPaneTemplates(act.Pane, out)
		}
	case RunAction:
		if act.Payload.IsArgv() {
			for _, el := range act.Payload.Argv {
				out = append(out, TextTemplates(el)...)
			}
		}
		out = append(out, TextTemplates(act.Cwd)...)
		for _, value := range act.Env {
			out = append(out, TextTemplates(value)...)
		}
		if act.Pane != nil {
			out = collectPaneTemplates(act.Pane, out)
		}
	case HerdrAction:
		out = collectTemplatesFromValue(act.Params, out)
	case WorkflowAction:
		for _, value := range act.Inputs {
			out = append(out, TextTemplates(value)...)
		}
	}
	return out
}

func stepTemplates(step Step) []TemplatePath {
	var out []TemplatePath
	for _, clause := range step.When {
		if p, ok := ParseTemplatePath(clause.Path); ok {
			out = append(out, p)
		}
	}
	return collectActionTemplates(step.Action, out)
}

// sensitiveContextKeys are context keys that can expose transcript data.
var sensitiveContextKeys = map[string]bool{"transcript": true, "transcript_file": true}

func isSensitiveContextPath(path TemplatePath) bool {
	return path.Root == "context" && len(path.Segments) > 0 && sensitiveContextKeys[path.Segments[0]]
}

// TemplateRefs lists every template a workflow's steps, returns,
// and recovery action reference.
func TemplateRefs(steps []Step, returns *ReturnsSpec, onFailure Action) []TemplatePath {
	var refs []TemplatePath
	for _, step := range steps {
		refs = append(refs, stepTemplates(step)...)
	}
	if returns != nil {
		if returns.Template != "" {
			refs = append(refs, TextTemplates(returns.Template)...)
		}
		for _, f := range returns.Fields {
			refs = append(refs, TextTemplates(f.Template)...)
		}
	}
	if onFailure != nil {
		refs = collectActionTemplates(onFailure, refs)
	}
	return refs
}

// NeedsTranscript reports whether any reference reaches transcript
// context.
func NeedsTranscript(steps []Step, returns *ReturnsSpec) bool {
	for _, ref := range TemplateRefs(steps, returns, nil) {
		if isSensitiveContextPath(ref) {
			return true
		}
	}
	return false
}

// NamespaceOpts are the inputs to BuildTemplateNamespace.
type NamespaceOpts struct {
	Ctx            config.InvocationContext
	Inputs         map[string]any
	Steps          map[string]any
	Agent          string
	Transcript     *string
	TranscriptFile *string
}

// BuildTemplateNamespace builds the canonical invocation context namespaces.
func BuildTemplateNamespace(opts NamespaceOpts) TemplateNamespace {
	context := map[string]any{
		"workspace": opts.Ctx.WorkspaceID,
		"tab":       opts.Ctx.TabID,
		"pane":      opts.Ctx.PaneID,
		"worktree":  opts.Ctx.WorktreePath,
		"cwd":       opts.Ctx.Cwd,
		"agent":     opts.Agent,
		"selection": config.SanitizeDisplay(opts.Ctx.Selection),
		"platform":  string(config.Platform()),
	}
	if opts.Transcript != nil {
		context["transcript"] = *opts.Transcript
	}
	if opts.TranscriptFile != nil {
		context["transcript_file"] = *opts.TranscriptFile
	}
	return TemplateNamespace{
		Inputs:  maps.Clone(opts.Inputs),
		Steps:   maps.Clone(opts.Steps),
		Context: context,
	}
}

func isTruthyScalar(value any) bool {
	switch v := value.(type) {
	case nil:
		return false
	case bool:
		return v
	case string:
		return v != ""
	case int:
		return v != 0
	case int64:
		return v != 0
	case float64:
		return v != 0 && !math.IsNaN(v) && !math.IsInf(v, 0)
	case json.Number:
		f, err := v.Float64()
		return err == nil && f != 0 && !math.IsNaN(f) && !math.IsInf(f, 0)
	}
	return true
}

func evaluateWhenClause(when WhenSpec, values TemplateNamespace) bool {
	resolved := SubstituteValue("{{"+when.Path+"}}", values)
	if when.Kind == WhenTruthy {
		return isTruthyScalar(resolved)
	}
	left := RenderScalar(resolved)
	if when.Negate {
		return left != when.Value
	}
	return left == when.Value
}

// EvaluateWhen is an ordered short-circuit AND over clauses. Empty is true.
func EvaluateWhen(when []WhenSpec, values TemplateNamespace) bool {
	for _, clause := range when {
		if !evaluateWhenClause(clause, values) {
			return false
		}
	}
	return true
}

// DynamicArgvRootRule is the load error for non-inputs roots in dynamic
// choice argv.
const DynamicArgvRootRule = "dynamic choice argv templates may only reference earlier inputs"

// DynamicChoiceInputRefs names the inputs a dynamic choice argv references,
// in first-seen order.
func DynamicChoiceInputRefs(dynamic DynamicChoice) []string {
	var out []string
	for _, element := range dynamic.Run {
		for _, path := range TextTemplates(element) {
			if path.Root == "inputs" && len(path.Segments) == 1 &&
				!slices.Contains(out, path.Segments[0]) {
				out = append(out, path.Segments[0])
			}
		}
	}
	return out
}
