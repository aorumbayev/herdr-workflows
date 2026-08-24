// Package workflow is the Workflow Authoring boundary.
// It parses YAML, validates it, and produces an immutable executable Definition.
package workflow

import (
	"regexp"
	"time"
)

// Format is the only workflow document version this parser supports.
const Format = "v1alpha1"

var (
	identRE    = regexp.MustCompile(`^[a-z][a-z0-9_]{0,31}$`)
	durationRE = regexp.MustCompile(`^([1-9]\d*)(ms|s|m|h)$`)
)

// NameRE constrains workflow file names.
var NameRE = regexp.MustCompile(`^[a-z0-9][a-z0-9-_]*$`)

// NameRule is the load error for a workflow name that fails NameRE.
const NameRule = "workflow name must match [a-z0-9][a-z0-9-_]*"

// Shells are the accepted `shell:` values. The parser accepts Windows shell
// names. Execution supports native Linux and macOS environments.
var Shells = []string{"sh", "bash", "zsh", "pwsh", "powershell", "cmd"}

// PaneOpens are the literal `pane.open` values.
var PaneOpens = []string{"tab", "beside", "below"}

// WhenKind identifies a truthiness clause or an equality clause.
type WhenKind int

const (
	// WhenTruthy examines the referenced scalar for truthiness.
	WhenTruthy WhenKind = iota
	// WhenEqual compares the text form of the referenced scalar with Value.
	WhenEqual
)

// WhenSpec is one parsed `when:` clause.
type WhenSpec struct {
	Kind   WhenKind
	Path   string
	Value  string
	Negate bool
}

// PaneSpec is the parsed `pane:` placement block.
type PaneSpec struct {
	Open      string // PaneOpens literal or a whole-value template
	Anchor    string
	Workspace string
	Size      *int
	Focus     *bool
	Name      string
	Close     string // empty, "success", or "always"
}

// RetrySpec is the parsed `retry:` block. Delay is zero when omitted.
type RetrySpec struct {
	Attempts int
	Delay    time.Duration
}

// ExpectSpec is the parsed verdict contract of an agent step.
type ExpectSpec struct {
	OneOf   []string
	Require []string
}

// RunPayload is the shell or argv form of a `run:` action.
type RunPayload struct {
	// Argv is nil for the shell form.
	Argv []string
	// Command is the shell source for the shell form.
	Command string
	// Shell is the explicit `shell:` value. Empty means the default sh.
	Shell string
}

func (p RunPayload) IsArgv() bool { return p.Argv != nil }

// Action is one step action: agent, run, herdr, or workflow.
type Action interface{ actionKind() string }

// AgentAction is a managed agent prompt.
type AgentAction struct {
	Prompt     string
	Using      string
	Target     string
	Cwd        string
	Env        map[string]string
	Pane       *PaneSpec
	Background bool
	Timeout    time.Duration
	Expect     *ExpectSpec
}

// RunAction is a command, local or placed.
type RunAction struct {
	Payload      RunPayload
	Cwd          string
	Env          map[string]string
	Pane         *PaneSpec
	Background   bool
	ReadyWhen    string
	Timeout      time.Duration
	Retry        *RetrySpec
	SuccessCodes []int
}

// HerdrAction is a raw herdr socket method call.
type HerdrAction struct {
	Method string
	Params map[string]any
	Retry  *RetrySpec
}

// WorkflowAction is a child workflow invocation.
type WorkflowAction struct {
	Name   string
	Inputs map[string]string
}

func (AgentAction) actionKind() string    { return "agent" }
func (RunAction) actionKind() string      { return "run" }
func (HerdrAction) actionKind() string    { return "herdr" }
func (WorkflowAction) actionKind() string { return "workflow" }

func ActionKind(a Action) string { return a.actionKind() }

// Step is one parsed workflow step.
type Step struct {
	ID              string
	When            []WhenSpec
	ContinueOnError bool
	Action          Action
}

// DynamicChoice discovers choice options from argv.
type DynamicChoice struct {
	Run []string
}

// InputSpec is the resolved declaration that validation and collection use.
type InputSpec struct {
	Name           string
	Type           string
	Description    string
	Default        *string
	Options        []string
	DynamicOptions *DynamicChoice
	When           []WhenSpec
	AllowCustom    bool
	MinLength      *int
}

// RawInputOptions are static options or a dynamic choice declaration.
type RawInputOptions struct {
	Static  []string
	Dynamic *DynamicChoice
}

// RawInputMap is the full map form of an input declaration.
type RawInputMap struct {
	Type        string
	Description *string
	Default     *string
	Options     *RawInputOptions
	When        []string
	WhenList    bool
	AllowCustom *bool
	MinLength   *int
}

// RawInputValue is one of the input declaration forms.
type RawInputValue interface{ rawInputValue() }

// RawInputShorthand is a text or profile input shorthand.
type RawInputShorthand string

// RawInputStatic is a static choice list.
type RawInputStatic []string

func (RawInputShorthand) rawInputValue() {}
func (RawInputStatic) rawInputValue()    {}
func (*RawInputMap) rawInputValue()      {}

// NamedInput keeps an input declaration with its name in document order.
type NamedInput struct {
	Name  string
	Value RawInputValue
}

// NamedTemplate keeps one `returns:` map entry in document order.
type NamedTemplate struct {
	Name     string
	Template string
}

// ReturnsSpec is the parsed `returns:` declaration: one whole-value
// template, or an ordered map of them.
type ReturnsSpec struct {
	Template string
	Fields   []NamedTemplate
}

// Document is the validated v1alpha1 YAML authoring value before the child-graph Definition.
type Document struct {
	Version     string
	Title       string
	Description string
	Hidden      bool
	Inputs      []NamedInput
	Returns     *ReturnsSpec
	OnFailure   Action
	Steps       []Step
}

// Definition is the immutable executable workflow that authoring produces.
// Children are the frozen child graph for one load/process.
type Definition struct {
	Name            string
	File            string
	Version         string
	Title           string
	Description     string
	Hidden          bool
	Steps           []Step
	Inputs          []InputSpec
	Returns         *ReturnsSpec
	OnFailure       Action
	RepoOwned       bool
	NeedsTranscript bool
	Children        map[string]*Definition
}

// SourceKind reports whether this definition loaded from the repo or the global store.
func (d Definition) SourceKind() string {
	if d.RepoOwned {
		return "repo"
	}
	return "global"
}

// ListEntry is the picker-facing metadata for one workflow file.
type ListEntry struct {
	Name               string
	Source             string
	File               string
	Error              string
	Hidden             bool
	Title              string
	Description        string
	NeedsTranscript    bool
	HasCommands        bool
	SensitiveMethods   []string
	UnresolvedChildren []string
	Inputs             []InputSpec
	DynamicOptions     bool
	RepoOwned          bool
}

// TemplatePath is a parsed template reference that starts at inputs, steps, or
// context.
type TemplatePath struct {
	Root     string
	Segments []string
}

// TemplateNamespace holds the values that templates resolve.
type TemplateNamespace struct {
	Inputs  map[string]any
	Steps   map[string]any
	Context map[string]any
}
