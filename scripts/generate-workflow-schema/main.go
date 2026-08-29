// Command generate-workflow-schema writes docs/workflow.schema.json and the
// embed/workflow.schema.json copy from the Go schema model. Start this command from the
// repository root with:
//
//	go run ./scripts/generate-workflow-schema
//
// Cross-field workflow rules stay in the loader of internal/workflow. This JSON schema
// does not contain those rules.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	pathpkg "path"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/invopop/jsonschema"
)

const (
	workflowDescription  = "Linear YAML workflow for the herdr-workflows herdr plugin (format v1alpha1). Cross-field rules are enforced by the parser and loader, not this schema."
	identPattern         = `^[a-z][a-z0-9_]{0,31}$`
	wholeTemplatePattern = `^\{\{\s*((?:inputs|steps|context)(?:\.[a-zA-Z_][a-zA-Z0-9_]*)+)\s*\}\}$`
	safeIntegerMaximum   = "9007199254740991"
	safeIntegerMinimum   = "-9007199254740991"
)

func minLength(value uint64) *uint64 { return &value }

func stringSchema(min uint64) *jsonschema.Schema {
	return &jsonschema.Schema{Type: "string", MinLength: minLength(min)}
}

func arraySchema(item *jsonschema.Schema, min uint64) *jsonschema.Schema {
	return &jsonschema.Schema{Type: "array", MinItems: minLength(min), Items: item}
}

func recordSchema(value, names *jsonschema.Schema) *jsonschema.Schema {
	return &jsonschema.Schema{
		Type:                 "object",
		PropertyNames:        names,
		AdditionalProperties: value,
	}
}

func emptySchema() *jsonschema.Schema { return &jsonschema.Schema{} }

func enumSchema(values ...any) *jsonschema.Schema {
	return &jsonschema.Schema{Type: "string", Enum: values}
}

type RunValue []string

func (RunValue) JSONSchema() *jsonschema.Schema {
	return &jsonschema.Schema{AnyOf: []*jsonschema.Schema{
		stringSchema(1),
		arraySchema(&jsonschema.Schema{Type: "string"}, 1),
	}}
}

type WhenValue struct{}

func (WhenValue) JSONSchema() *jsonschema.Schema {
	return &jsonschema.Schema{AnyOf: []*jsonschema.Schema{
		stringSchema(1),
		arraySchema(stringSchema(1), 1),
	}}
}

type ShellValue string

func (ShellValue) JSONSchema() *jsonschema.Schema {
	return enumSchema("sh", "bash", "zsh", "pwsh", "powershell", "cmd")
}

type PaneOpen string

func (PaneOpen) JSONSchema() *jsonschema.Schema {
	return &jsonschema.Schema{AnyOf: []*jsonschema.Schema{
		enumSchema("tab", "beside", "below"),
		{Type: "string", Pattern: wholeTemplatePattern},
	}}
}

type Identifier string

func (Identifier) JSONSchema() *jsonschema.Schema {
	return &jsonschema.Schema{Type: "string", Pattern: identPattern}
}

type ParamsRecord map[string]any

func (ParamsRecord) JSONSchema() *jsonschema.Schema {
	return recordSchema(emptySchema(), &jsonschema.Schema{Type: "string"})
}

type StringRecord map[string]string

func (StringRecord) JSONSchema() *jsonschema.Schema {
	return recordSchema(&jsonschema.Schema{Type: "string"}, &jsonschema.Schema{Type: "string"})
}

type NonEmptyStringList []string

func (NonEmptyStringList) JSONSchema() *jsonschema.Schema {
	return arraySchema(stringSchema(1), 1)
}

type SuccessCodes []int

func (SuccessCodes) JSONSchema() *jsonschema.Schema {
	return &jsonschema.Schema{
		Type:     "array",
		MinItems: minLength(1),
		Items: &jsonschema.Schema{
			Type:    "integer",
			Minimum: safeIntegerMinimum,
			Maximum: safeIntegerMaximum,
		},
	}
}

type OptionsValue struct{}

func (OptionsValue) JSONSchema() *jsonschema.Schema {
	static := arraySchema(stringSchema(1), 1)
	properties := jsonschema.NewProperties()
	properties.Set("run", &jsonschema.Schema{
		Description: "argv run from the repo root to discover the options, one per line. Elements may template `{{inputs.<earlier>}}` to cascade from an earlier answer; `steps` and `context` roots are load errors. Treat it as read-only. Capped at 10s, 1,000 options, and 8 MiB.",
		Type:        "array",
		MinItems:    minLength(1),
		Items:       stringSchema(1),
	})
	dynamic := &jsonschema.Schema{
		Type:       "object",
		Properties: properties,
		Required:   []string{"run"},
	}
	dynamic.AdditionalProperties = jsonschema.FalseSchema
	return &jsonschema.Schema{
		AnyOf: []*jsonschema.Schema{
			static,
			dynamic,
		},
	}
}

type InputRecord map[string]any

func inputMapSchema() *jsonschema.Schema {
	properties := jsonschema.NewProperties()
	properties.Set("type", &jsonschema.Schema{
		Type:        "string",
		Enum:        []any{"text", "choice", "profile"},
		Description: "`text` accepts free-form input, `choice` picks from `options:`, `profile` picks from the configured profile names. Inferred as `choice` when `options:` is set, otherwise `text`.",
	})
	properties.Set("description", &jsonschema.Schema{
		Type:        "string",
		Description: "Shown in the prompt. This is the only part of the prompt line an author controls, so describe every input.",
	})
	properties.Set("default", &jsonschema.Schema{
		Type:        "string",
		Description: "Pre-filled answer. For a closed `choice` or `profile` it must be one of the available values.",
	})
	options := OptionsValue{}.JSONSchema()
	options.Description = "Values a `choice` offers: a static list, or `{run: argv}` to discover them."
	properties.Set("options", options)
	when := WhenValue{}.JSONSchema()
	when.Description = "Guards, in order, that may reference earlier inputs. An inactive input never prompts, resolves, or exports an `HWF_` value, and supplying one fails collection."
	properties.Set("when", when)
	properties.Set("allow_custom", &jsonschema.Schema{
		Type:        "boolean",
		Description: "Accept values outside `options:`, making the list suggestions. `choice` only.",
	})
	properties.Set("min_length", &jsonschema.Schema{
		Type:        "integer",
		Minimum:     "0",
		Maximum:     safeIntegerMaximum,
		Description: "Minimum number of characters for an active answer.",
	})
	return &jsonschema.Schema{
		Type:                 "object",
		Properties:           properties,
		AdditionalProperties: jsonschema.FalseSchema,
		Description:          "Full declaration, for a default, a guard, or discovered options.",
	}
}

func (InputRecord) JSONSchema() *jsonschema.Schema {
	return recordSchema(&jsonschema.Schema{AnyOf: []*jsonschema.Schema{
		{Type: "string", Const: "text", Description: "Shorthand for a free-form text input with no other settings."},
		{Type: "string", Const: "profile", Description: "Shorthand for a choice over the configured profile names."},
		{
			Description: "Shorthand for a closed static choice over these values.",
			Type:        "array",
			MinItems:    minLength(1),
			Items:       stringSchema(1),
		},
		{
			Type:                 "object",
			Properties:           inputMapSchema().Properties,
			AdditionalProperties: jsonschema.FalseSchema,
			Description:          "Full declaration, for a default, a guard, or discovered options.",
		},
	}}, &jsonschema.Schema{
		Type:    "string",
		Pattern: identPattern,
	})
}

type ReturnsValue struct{}

func (ReturnsValue) JSONSchema() *jsonschema.Schema {
	return &jsonschema.Schema{AnyOf: []*jsonschema.Schema{
		{Description: "A single template, which becomes the whole result.", Type: "string", MinLength: minLength(1)},
		{
			Description:          "Named templates, which become the fields of the result.",
			Type:                 "object",
			PropertyNames:        &jsonschema.Schema{Type: "string", Pattern: identPattern},
			AdditionalProperties: stringSchema(1),
		},
	}}
}

// PaneSpec describes stable pane placement.
type PaneSpec struct {
	// Where the pane goes: a new `tab`, or a `beside`/`below` split of the anchor pane. Accepts a whole-value template when the referenced input is an unconditional closed static choice of those three values.
	Open PaneOpen `json:"open"`
	// Pane to split. `beside`/`below` only; defaults to the invocation pane.
	Target string `json:"target,omitempty" jsonschema:"minLength=1"`
	// Workspace for the new tab. `tab` only; defaults to the invocation workspace.
	Workspace string `json:"workspace,omitempty" jsonschema:"minLength=1"`
	// Percent of the anchor given to the new pane. `beside`/`below` only. herdr clamps the effective split ratio, so an extreme value is approximated rather than rejected.
	Size int `json:"size,omitempty" jsonschema:"minimum=1,maximum=99"`
	// Focus the new pane once it opens.
	Focus bool `json:"focus,omitempty"`
	// Name for the created tab, set when the tab opens. `tab` only, because a split joins an existing tab. Template-capable. Defaults to the step ID, which also covers a name that renders blank.
	Name string `json:"name,omitempty" jsonschema:"minLength=1"`
	// Close the pane after a successful turn, or after any turn. Foreground `agent:` steps only — a `run:` step and a background step both reject it.
	Close string `json:"close,omitempty" jsonschema:"enum=success,enum=always"`
}

// RetrySpec describes constrained retry behavior.
type RetrySpec struct {
	// Total attempts including the first, so at least 2.
	Attempts int `json:"attempts" jsonschema:"minimum=2,maximum=9007199254740991"`
	// Wait between attempts.
	Delay string `json:"delay,omitempty" jsonschema:"pattern=^([1-9]\\d*)(ms|s|m|h)$"`
}

// ExpectSpec describes verdict tokens.
type ExpectSpec struct {
	// Distinct verdict tokens the agent must end its managed response with, on the final non-empty line.
	OneOf []VerdictToken `json:"one_of" jsonschema:"minItems=1"`
	// Subset of `one_of` that lets the step succeed. Omit it to accept every token.
	Require []VerdictToken `json:"require,omitempty" jsonschema:"minItems=1"`
}

type VerdictToken string

func (VerdictToken) JSONSchema() *jsonschema.Schema {
	return &jsonschema.Schema{Type: "string", Pattern: `^[A-Z][A-Z0-9_]{0,31}$`}
}

// SharedFields are fields shared by every action in the authoring schema.
type SharedFields struct {
	// Action: prompt text for an agent. Pair with `using:` to start a new agent or `target:` to address a running one. The result is `{response, agent, pane_id}`; the default turn timeout is 30 minutes.
	Agent string `json:"agent,omitempty"`
	// Profile that starts a new managed agent for this prompt. Mutually exclusive with `target:`; omit both to use the default profile.
	Using string `json:"using,omitempty" jsonschema:"minLength=1"`
	// Existing agent name or pane ID to prompt, which must be idle or done. On a step it rejects `pane:`, `cwd:`, and `env:` because the agent already has a pane. Mutually exclusive with `using:`.
	Target string `json:"target,omitempty" jsonschema:"minLength=1"`
	// Action: a command. A list is argv with no shell; a string runs through `shell:`. Inputs are exported as `HWF_<name>`. A blocking local run results in `{stdout, stderr, exit_code, failed}`; a placed run results in its readiness payload, and a background run has no result to reference.
	Run RunValue `json:"run,omitempty"`
	// Shell for a string `run:`, defaulting to `sh`. The argv form rejects it, since argv runs without a shell.
	Shell ShellValue `json:"shell,omitempty"`
	// Action: a herdr socket method such as `notification.show`. Nothing is filled in automatically, and a denied method fails at load. The result is the complete herdr payload.
	Herdr string `json:"herdr,omitempty"`
	// Arguments for the `herdr:` method.
	Params ParamsRecord `json:"params,omitempty"`
	// Action: a child workflow, run in isolation. Its `returns:` becomes this step's result; its own `on_failure` does not run under a parent.
	Workflow string `json:"workflow,omitempty"`
	// Values passed to the child workflow, keyed by its declared input names.
	Inputs StringRecord `json:"inputs,omitempty"`
	// Working directory, defaulting to the invocation working directory. `agent:` and `run:` steps only; `herdr:` and `workflow:` reject it.
	Cwd string `json:"cwd,omitempty" jsonschema:"minLength=1"`
	// Extra environment variables. `agent:` and `run:` steps only. The `HWF_` prefix is reserved for exported inputs: a `run:` step fails on one at runtime rather than at load, and an agent step passes it through.
	Env StringRecord `json:"env,omitempty"`
	// Place this step in a herdr pane instead of running it invisibly. `agent:` and `run:` steps only. A placed `run:` must also set `background:` or `ready_when:`, and rejects `pane.close`.
	Pane PaneSpec `json:"pane,omitempty"`
	// `/regex/`, no flags, matched against recent pane output to decide the step is ready. `run:` only, and requires both `pane:` and `timeout:`. Matches text already on screen, and does not detect process exit.
	ReadyWhen string `json:"ready_when,omitempty"`
	// Time limit for an `agent:` or `run:` step; `herdr:` and `workflow:` reject it. Omitting it leaves a local `run:` uncapped, but an agent turn still falls back to 30 minutes, and a placed `run:` with `ready_when:` requires it.
	Timeout string `json:"timeout,omitempty" jsonschema:"pattern=^([1-9]\\d*)(ms|s|m|h)$"`
	// Verdict contract for a blocking `agent:` turn. The runner tells the agent to end the managed response with one `one_of` token and to verify it with `hwf response check`, then binds the matched token as `verdict`. A missing, unlisted, or non-`require` verdict fails the step. Rejected on `background:` and on the other three actions.
	Expect ExpectSpec `json:"expect,omitempty"`
	// Exit codes counted as success instead of the default `[0]`. Blocking local `run:` steps only — a placed, background, or `on_failure` run rejects it, as do the other three actions.
	SuccessCodes SuccessCodes `json:"success_codes,omitempty"`
}

type UnknownValue struct{}

func (UnknownValue) JSONSchema() *jsonschema.Schema { return emptySchema() }

type WorkflowStep struct {
	// Name this step so later steps can read `{{steps.<id>.field}}` from its result.
	ID Identifier `json:"id,omitempty"`
	// Guard: one clause, or an ordered list evaluated as a short-circuit AND. A clause is a truthiness check or an `==`/`!=` comparison against a quoted string. A false result skips the step.
	When WhenValue `json:"when,omitempty"`
	// Tolerate an ordinary failure here: later steps continue and `on_failure` is suppressed, though the run still exits nonzero. A hard failure — a timeout, a capture overflow, or a spawn error — aborts anyway, and lost herdr coordination aborts before this is consulted.
	ContinueOnError bool `json:"continue_on_error,omitempty"`
	SharedFields
	// Start the step and move on without waiting, so it produces no result to reference. The process is pane-owned and survives client detach, but not a herdr server restart. Rejects `timeout:`, `retry:`, and `pane.close`; a background `run:` also requires `pane:`.
	Background bool `json:"background,omitempty"`
	// Retry a failed attempt. `run:` and `herdr:` steps only, and never on a background step or in `on_failure`.
	Retry RetrySpec `json:"retry,omitempty"`
}

func (WorkflowStep) JSONSchemaExtend(schema *jsonschema.Schema) {
	schema.AdditionalProperties = emptySchema()
}

// RecoveryStep is the top-level on_failure action shape.
type RecoveryStep struct {
	SharedFields
	// Not valid on `on_failure`, which runs once and is never guarded.
	ID UnknownValue `json:"id,omitempty"`
	// Not valid on `on_failure`, which runs once and is never guarded.
	When UnknownValue `json:"when,omitempty"`
	// Not valid on `on_failure`, which runs once and is never guarded.
	ContinueOnError UnknownValue `json:"continue_on_error,omitempty"`
	// Not valid on `on_failure`, which runs once and is never guarded.
	Background UnknownValue `json:"background,omitempty"`
	// Not valid on `on_failure`, which runs once and is never guarded.
	Retry UnknownValue `json:"retry,omitempty"`
}

func (RecoveryStep) JSONSchemaExtend(schema *jsonschema.Schema) {
	schema.AdditionalProperties = emptySchema()
}

// WorkflowDoc is the v1alpha1 document model used for schema generation.
type WorkflowDoc struct {
	// Workflow format version. Must be `v1alpha1`; any other value fails the load with rewrite-or-upgrade guidance.
	Version string `json:"version"`
	// Picker label. Defaults to the humanized filename, and is truncated to the picker row width.
	Title string `json:"title,omitempty"`
	// Picker subtitle, wrapped or truncated to at most two rows.
	Description string `json:"description,omitempty"`
	// Hide from the picker. `hwf run` still launches the workflow.
	Hidden bool `json:"hidden,omitempty"`
	// Values collected before the run, keyed by a name matching `[a-z][a-z0-9_]{0,31}`. Only the entry workflow prompts, in declaration order; a child receives values from its parent's step `inputs:`.
	Inputs InputRecord `json:"inputs,omitempty"`
	// What a parent's `workflow:` step gets as this workflow's result.
	Returns ReturnsValue `json:"returns,omitempty"`
	// Recovery action, run once after the first non-tolerated failure. Entry workflow only, and `{{context.error}}` is available. Rejects `id`, `when`, `continue_on_error`, `background`, `retry`, and `success_codes`. Skipped entirely when herdr coordination is lost.
	OnFailure RecoveryStep `json:"on_failure,omitempty"`
	// Steps in execution order. Each uses exactly one of `agent:`, `run:`, `herdr:`, or `workflow:`.
	Steps []WorkflowStep `json:"steps" jsonschema:"minItems=1"`
}

func buildSchema() (*jsonschema.Schema, error) {
	reflector := &jsonschema.Reflector{DoNotReference: true, ExpandedStruct: true}
	_, sourceFile, _, ok := runtime.Caller(0)
	if !ok {
		return nil, fmt.Errorf("cannot locate schema generator source")
	}
	packageDir, err := filepath.Abs(filepath.Dir(sourceFile))
	if err != nil {
		return nil, err
	}
	packagePath := reflect.TypeOf(WorkflowDoc{}).PkgPath()
	if err := reflector.AddGoComments(packagePath, packageDir); err != nil {
		return nil, err
	}
	commentPrefix := pathpkg.Join(packagePath, filepath.ToSlash(packageDir))
	for key, comment := range reflector.CommentMap {
		suffix, found := strings.CutPrefix(key, commentPrefix)
		if !found || (suffix != "" && !strings.HasPrefix(suffix, ".")) {
			continue
		}
		reflector.CommentMap[packagePath+suffix] = comment
		delete(reflector.CommentMap, key)
	}
	schema := reflector.Reflect(&WorkflowDoc{})
	schema.ID = jsonschema.ID(config.WorkflowSchemaURL())
	schema.Title = "herdr-workflows workflow"
	schema.Description = workflowDescription
	return schema, nil
}

func schemaJSON() ([]byte, error) {
	schema, err := buildSchema()
	if err != nil {
		return nil, err
	}
	raw, err := json.MarshalIndent(schema, "", "  ")
	if err != nil {
		return nil, err
	}
	raw = bytes.ReplaceAll(raw, []byte(`\u003c`), []byte("<"))
	raw = bytes.ReplaceAll(raw, []byte(`\u003e`), []byte(">"))
	raw = bytes.ReplaceAll(raw, []byte(`\u0026`), []byte("&"))
	return raw, nil
}

func writeSchema(path string) error {
	data, err := schemaJSON()
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0o644)
}

func main() {
	for _, dir := range []string{"docs", "embed"} {
		path := filepath.Join(dir, "workflow.schema.json")
		if err := writeSchema(path); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Printf("wrote %s\n", path)
	}
}
