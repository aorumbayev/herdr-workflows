package workflow

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"unicode"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/host"
)

// Sensitivity is the trust-relevant surface of one workflow tree.
type Sensitivity struct {
	HasCommands        bool
	HasTranscript      bool
	SensitiveMethods   []string
	UnresolvedChildren []string
}

var sensitiveAllowedMethods = map[string]bool{
	"pane.close":      true,
	"tab.close":       true,
	"workspace.close": true,
	"agent.send_keys": true,
	"pane.send_keys":  true,
	"pane.send_text":  true,
	"pane.send_input": true,
	"worktree.create": true,
	"layout.apply":    true,
}

// AssertWorkflowName validates a workflow file name and returns its trimmed
// form.
func AssertWorkflowName(name string) (string, error) {
	trimmed := strings.TrimSpace(name)
	if !NameRE.MatchString(trimmed) {
		return "", &LoadError{NameRule}
	}
	return trimmed, nil
}

// Path returns the repository or global workflow path.
func Path(scope, repoRoot, name string) (string, error) {
	validated, err := AssertWorkflowName(name)
	if err != nil {
		return "", err
	}
	if scope == "repo" {
		return filepath.Join(repoRoot, ".hwf", "workflows", validated+".yaml"), nil
	}
	if scope == "global" {
		home, err := config.HomeDir(nil)
		if err != nil {
			return "", err
		}
		return filepath.Join(home, ".hwf", "workflows", validated+".yaml"), nil
	}
	return "", &LoadError{"workflow scope must be repo or global"}
}

// ResolvedWorkflowFile identifies the repository or global definition that
// won name resolution.
type ResolvedWorkflowFile struct {
	File   string
	Source string
}

// ErrWorkflowNotFound means neither workflow scope contains the name.
var ErrWorkflowNotFound = errors.New("workflow not found")

// ResolveWorkflowFile prefers a repository workflow over a global workflow.
func ResolveWorkflowFile(name, repoRoot string) (*ResolvedWorkflowFile, error) {
	repo, err := Path("repo", repoRoot, name)
	if err != nil {
		return nil, err
	}
	global, err := Path("global", repoRoot, name)
	if err != nil {
		return nil, err
	}
	if repo != global {
		if _, statErr := os.Stat(repo); statErr == nil {
			return &ResolvedWorkflowFile{File: repo, Source: "repo"}, nil
		} else if !os.IsNotExist(statErr) {
			return nil, statErr
		}
	}
	if _, statErr := os.Stat(global); statErr == nil {
		return &ResolvedWorkflowFile{File: global, Source: "global"}, nil
	} else if !os.IsNotExist(statErr) {
		return nil, statErr
	}
	return nil, ErrWorkflowNotFound
}

func isSensitiveHerdrMethod(method string) bool {
	if _, denied := host.MethodDeniedReason(method); denied {
		return true
	}
	return sensitiveAllowedMethods[method]
}

func collectHerdrMethods(steps []Step, onFailure Action) []string {
	var methods []string
	for _, step := range steps {
		if action, ok := step.Action.(HerdrAction); ok {
			methods = append(methods, action.Method)
		}
	}
	if action, ok := onFailure.(HerdrAction); ok {
		methods = append(methods, action.Method)
	}
	return methods
}

func childWorkflowNames(steps []Step, onFailure Action) []string {
	var names []string
	for _, step := range steps {
		if action, ok := step.Action.(WorkflowAction); ok {
			names = append(names, action.Name)
		}
	}
	if action, ok := onFailure.(WorkflowAction); ok {
		names = append(names, action.Name)
	}
	return names
}

func analyzeWorkflowSensitivity(raw Document) Sensitivity {
	flags := Sensitivity{}
	for _, step := range raw.Steps {
		if _, ok := step.Action.(RunAction); ok {
			flags.HasCommands = true
		}
	}
	if _, ok := raw.OnFailure.(RunAction); ok {
		flags.HasCommands = true
	}
	for _, path := range TemplateRefs(raw.Steps, raw.Returns, raw.OnFailure) {
		if isSensitiveContextPath(path) {
			flags.HasTranscript = true
		}
	}
	for _, method := range collectHerdrMethods(raw.Steps, raw.OnFailure) {
		if isSensitiveHerdrMethod(method) {
			flags.SensitiveMethods = appendUnique(flags.SensitiveMethods, method)
		}
	}
	sort.Strings(flags.SensitiveMethods)
	return flags
}

// AnalyzeResolvedSensitivity includes sensitivity from reachable child
// workflows and records children that cannot be loaded.
func AnalyzeResolvedSensitivity(raw Document, name, repoRoot string) Sensitivity {
	return analyzeResolvedSensitivity(raw, name, repoRoot, nil)
}

func analyzeResolvedSensitivity(raw Document, name, repoRoot string, stack []string) Sensitivity {
	local := analyzeWorkflowSensitivity(raw)
	if slices.Contains(stack, name) {
		return local
	}
	nextStack := append(slices.Clone(stack), name)
	aggregated := Sensitivity{
		HasCommands:        local.HasCommands,
		HasTranscript:      local.HasTranscript,
		SensitiveMethods:   slices.Clone(local.SensitiveMethods),
		UnresolvedChildren: nil,
	}
	for _, childName := range childWorkflowNames(raw.Steps, raw.OnFailure) {
		if slices.Contains(nextStack, childName) {
			continue
		}
		resolved, err := ResolveWorkflowFile(childName, repoRoot)
		if err != nil {
			aggregated.UnresolvedChildren = appendUnique(aggregated.UnresolvedChildren, childName)
			continue
		}
		body, err := os.ReadFile(resolved.File)
		if err != nil {
			aggregated.UnresolvedChildren = appendUnique(aggregated.UnresolvedChildren, childName)
			continue
		}
		child, err := ParseRaw(resolved.File, string(body))
		if err != nil {
			aggregated.UnresolvedChildren = appendUnique(aggregated.UnresolvedChildren, childName)
			continue
		}
		MergeSensitivity(&aggregated, analyzeResolvedSensitivity(child, childName, repoRoot, nextStack))
	}
	sort.Strings(aggregated.SensitiveMethods)
	sort.Strings(aggregated.UnresolvedChildren)
	return aggregated
}

func appendUnique(values []string, value string) []string {
	if slices.Contains(values, value) {
		return values
	}
	return append(values, value)
}

// ReferencedWorkflowChildren returns unique child names in sorted order.
func ReferencedWorkflowChildren(raw Document) []string {
	var names []string
	for _, name := range childWorkflowNames(raw.Steps, raw.OnFailure) {
		if !slices.Contains(names, name) {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names
}

// MergeSensitivity combines one sensitivity result into another.
func MergeSensitivity(into *Sensitivity, from Sensitivity) {
	into.HasCommands = into.HasCommands || from.HasCommands
	into.HasTranscript = into.HasTranscript || from.HasTranscript
	for _, method := range from.SensitiveMethods {
		into.SensitiveMethods = appendUnique(into.SensitiveMethods, method)
	}
	for _, child := range from.UnresolvedChildren {
		into.UnresolvedChildren = appendUnique(into.UnresolvedChildren, child)
	}
}

// HumanizeWorkflowName converts hyphen/underscore names to title case.
func HumanizeWorkflowName(name string) string {
	spaced := strings.TrimSpace(workflowSeparatorRE.ReplaceAllString(name, " "))
	if spaced == "" {
		return name
	}
	runes := []rune(spaced)
	wordStart := true
	for i, r := range runes {
		if unicode.IsLetter(r) && wordStart {
			runes[i] = unicode.ToUpper(r)
		}
		wordStart = !unicode.IsLetter(r) && !unicode.IsDigit(r)
	}
	return string(runes)
}

var workflowSeparatorRE = regexp.MustCompile(`[-_]+`)

// DisplayTitle uses the explicit title or a humanized workflow name.
func DisplayTitle(name, title string) string {
	if trimmed := strings.TrimSpace(title); trimmed != "" {
		return trimmed
	}
	return HumanizeWorkflowName(name)
}

// SensitivityLabels returns the compact trust labels used by the UI.
func SensitivityLabels(flags Sensitivity) []string {
	labels := make([]string, 0, 2+len(flags.SensitiveMethods)+len(flags.UnresolvedChildren))
	if flags.HasCommands {
		labels = append(labels, "commands")
	}
	if flags.HasTranscript {
		labels = append(labels, "transcript")
	}
	for _, method := range flags.SensitiveMethods {
		labels = append(labels, "herdr:"+method)
	}
	for _, child := range flags.UnresolvedChildren {
		labels = append(labels, "unresolved:"+child)
	}
	return labels
}

// FormatSensitivityBanner formats a visible trust banner, or empty text for
// a workflow with no flagged surface.
func FormatSensitivityBanner(flags Sensitivity, labelArgs ...string) string {
	labels := SensitivityLabels(flags)
	if len(labels) == 0 {
		return ""
	}
	label := "sensitive"
	if len(labelArgs) > 0 && labelArgs[0] != "" {
		label = labelArgs[0]
	}
	return "⚠ " + label + ": " + strings.Join(labels, " · ") + "\n"
}
