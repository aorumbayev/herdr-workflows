package workflow

import (
	"fmt"
	"slices"
	"strings"

	"github.com/aorumbayev/herdr-workflows/internal/host"
)

type producerKind string

const (
	producerAgent     producerKind = "agent"
	producerCommand   producerKind = "command"
	producerReadiness producerKind = "readiness"
	producerHerdr     producerKind = "herdr"
	producerChild     producerKind = "child"
	producerNone      producerKind = "none"
)

type stepProducer struct {
	ID           string
	Index        int
	Kind         producerKind
	HerdrMethod  string
	ChildReturns *ReturnsSpec
	NoneReason   string
	When         []WhenSpec
	HasVerdict   bool
}

type sourceType string

const (
	sourceString  sourceType = "string"
	sourceNumber  sourceType = "number"
	sourceBool    sourceType = "boolean"
	sourceObject  sourceType = "object"
	sourceUnknown sourceType = "unknown"
)

type templateOptions struct {
	Producers         map[string]stepProducer
	Inputs            map[string]InputSpec
	EarlierOnly       bool
	MaxStepIndex      int
	RejectSensitive   bool
	AllowContextError bool
	Proven            []WhenSpec
}

func localCommand(step Step) bool {
	action, ok := step.Action.(RunAction)
	return ok && action.Pane == nil && !action.Background
}

func placedOrReady(step Step) bool {
	action, ok := step.Action.(RunAction)
	return ok && (action.Pane != nil || action.ReadyWhen != "")
}

func classifyProducer(step Step, index int, childReturns *ReturnsSpec) (stepProducer, bool) {
	if step.ID == "" {
		return stepProducer{}, false
	}
	base := stepProducer{ID: step.ID, Index: index, When: slices.Clone(step.When)}
	if action, ok := step.Action.(RunAction); ok && action.Background {
		base.Kind, base.NoneReason = producerNone, "background steps produce no result"
		return base, true
	}
	if action, ok := step.Action.(AgentAction); ok && action.Background {
		base.Kind, base.NoneReason = producerNone, "background steps produce no result"
		return base, true
	}
	if step.ContinueOnError && !localCommand(step) {
		base.Kind, base.NoneReason = producerNone, "continue_on_error step may fail without a natural result"
		return base, true
	}
	switch action := step.Action.(type) {
	case AgentAction:
		base.Kind, base.HasVerdict = producerAgent, action.Expect != nil
	case HerdrAction:
		base.Kind, base.HerdrMethod = producerHerdr, action.Method
	case WorkflowAction:
		if childReturns == nil {
			base.Kind, base.NoneReason = producerNone, "child workflow declares no returns:"
		} else {
			base.Kind, base.ChildReturns = producerChild, childReturns
		}
	case RunAction:
		if placedOrReady(step) {
			base.Kind = producerReadiness
		} else {
			base.Kind = producerCommand
		}
	default:
		base.Kind, base.NoneReason = producerNone, "step produces no result"
	}
	return base, true
}

func assertUniqueStepIDs(file string, steps []Step) error {
	seen := map[string]int{}
	for i, step := range steps {
		if step.ID == "" {
			continue
		}
		index := i + 1
		if previous, ok := seen[step.ID]; ok {
			return bail(file, index, "id", fmt.Sprintf("duplicate step id '%s' (also step %d)", step.ID, previous))
		}
		seen[step.ID] = index
	}
	return nil
}

func globalResultFieldAllowed(field string) bool {
	return host.IsGlobalResultDotPath(field)
}

func unknownField(file string, step int, key, kind string, producer stepProducer, segments []string) error {
	return bail(file, step, key, fmt.Sprintf("unknown %s result field '%s' on step '%s'", kind, strings.Join(segments, "."), producer.ID))
}

func assertCommandField(file string, step int, key string, producer stepProducer, segments []string) error {
	if len(segments) == 0 || (len(segments) == 1 && CommandFields[segments[0]]) {
		return nil
	}
	return unknownField(file, step, key, "command", producer, segments)
}

func assertAgentField(file string, step int, key string, producer stepProducer, segments []string) error {
	if len(segments) == 0 {
		return nil
	}
	head := segments[0]
	if AgentStringFields[head] {
		if len(segments) != 1 {
			return unknownField(file, step, key, "managed agent", producer, segments)
		}
		return nil
	}
	if head == AgentVerdictField {
		if !producer.HasVerdict {
			return bail(file, step, key, fmt.Sprintf("step '%s' declares no expect:, so it produces no %s", producer.ID, AgentVerdictField))
		}
		if len(segments) != 1 {
			return unknownField(file, step, key, "managed agent", producer, segments)
		}
		return nil
	}
	if head == AgentInfoField {
		if len(segments) == 1 || globalResultFieldAllowed(strings.Join(segments, ".")) {
			return nil
		}
	}
	return unknownField(file, step, key, "managed agent", producer, segments)
}

func assertReadinessField(file string, step int, key string, producer stepProducer, segments []string) error {
	if len(segments) == 0 {
		return nil
	}
	if len(segments) == 1 && ReadinessIDFields[segments[0]] {
		return nil
	}
	if host.IsMethodResultDotPath("pane.wait_for_output", strings.Join(segments, ".")) {
		return nil
	}
	return unknownField(file, step, key, "readiness", producer, segments)
}

func assertHerdrField(file string, step int, key string, producer stepProducer, segments []string) error {
	if len(segments) == 0 || host.IsMethodResultDotPath(producer.HerdrMethod, strings.Join(segments, ".")) {
		return nil
	}
	return unknownField(file, step, key, "herdr", producer, segments)
}

func assertChildField(file string, step int, key string, producer stepProducer, segments []string) error {
	if len(segments) == 0 {
		return nil
	}
	if producer.ChildReturns.Template != "" {
		return nil
	}
	field := segments[0]
	for _, named := range producer.ChildReturns.Fields {
		if named.Name == field {
			return nil
		}
	}
	return bail(file, step, key, fmt.Sprintf("unknown child return '%s' on step '%s'", field, producer.ID))
}

func assertProducerField(file string, step int, key string, producer stepProducer, segments []string) error {
	if producer.Kind == producerNone {
		return bail(file, step, key, fmt.Sprintf("step '%s' produces no result (%s)", producer.ID, producer.NoneReason))
	}
	switch producer.Kind {
	case producerCommand:
		return assertCommandField(file, step, key, producer, segments)
	case producerAgent:
		return assertAgentField(file, step, key, producer, segments)
	case producerReadiness:
		return assertReadinessField(file, step, key, producer, segments)
	case producerHerdr:
		return assertHerdrField(file, step, key, producer, segments)
	default:
		return assertChildField(file, step, key, producer, segments)
	}
}

var contextStringFields = map[string]bool{
	"workspace": true, "tab": true, "pane": true, "worktree": true, "cwd": true,
	"agent": true, "selection": true, "platform": true, "transcript": true, "transcript_file": true,
}

var contextErrorStringFields = map[string]bool{"message": true, "workflow": true, "action": true, "step_id": true}

func assertContextPath(file string, step int, key string, segments []string, allowError bool) error {
	if len(segments) == 0 {
		return bail(file, step, key, "context reference requires a field")
	}
	if contextStringFields[segments[0]] {
		if len(segments) != 1 {
			return bail(file, step, key, fmt.Sprintf("unknown context path '%s'", strings.Join(segments, ".")))
		}
		return nil
	}
	if segments[0] != "error" {
		return bail(file, step, key, fmt.Sprintf("unknown context path '%s'", strings.Join(segments, ".")))
	}
	if !allowError {
		return bail(file, step, key, "context.error is only available inside on_failure:")
	}
	if len(segments) == 1 {
		return nil
	}
	field := segments[1]
	if contextErrorStringFields[field] || field == "step_number" || field == "workflow_path" || field == "details" {
		if field == "workflow_path" || field == "details" {
			return nil
		}
		if len(segments) != 2 {
			return bail(file, step, key, fmt.Sprintf("unknown context path '%s'", strings.Join(segments, ".")))
		}
		return nil
	}
	return bail(file, step, key, fmt.Sprintf("unknown context path '%s'", strings.Join(segments, ".")))
}

func sourceTypeOf(path TemplatePath, producers map[string]stepProducer, inputs map[string]InputSpec) sourceType {
	if path.Root == "inputs" {
		if len(path.Segments) == 1 {
			if _, ok := inputs[path.Segments[0]]; ok {
				return sourceString
			}
		}
		return sourceUnknown
	}
	//nolint:nestif // context.error has a fixed, intentionally explicit path shape.
	if path.Root == "context" {
		if len(path.Segments) == 0 {
			return sourceUnknown
		}
		if contextStringFields[path.Segments[0]] && len(path.Segments) == 1 {
			return sourceString
		}
		if path.Segments[0] == "error" {
			if len(path.Segments) == 1 {
				return sourceObject
			}
			switch path.Segments[1] {
			case "message", "workflow", "action", "step_id":
				if len(path.Segments) == 2 {
					return sourceString
				}
			case "step_number":
				if len(path.Segments) == 2 {
					return sourceNumber
				}
			case "workflow_path", "details":
				if len(path.Segments) == 2 {
					return sourceObject
				}
			}
		}
		return sourceUnknown
	}
	producer, ok := producers[path.Segments[0]]
	if !ok || producer.Kind == producerNone {
		return sourceUnknown
	}
	fields := path.Segments[1:]
	if len(fields) == 0 {
		return sourceObject
	}
	if producer.Kind == producerCommand {
		if len(fields) == 1 {
			if fieldType, ok := CommandFieldTypes[fields[0]]; ok {
				switch fieldType {
				case "string":
					return sourceString
				case "number":
					return sourceNumber
				case "boolean":
					return sourceBool
				}
			}
		}
		return sourceUnknown
	}
	if producer.Kind == producerAgent {
		if len(fields) == 1 && AgentStringFields[fields[0]] {
			return sourceString
		}
		if len(fields) == 1 && fields[0] == AgentVerdictField && producer.HasVerdict {
			return sourceString
		}
		if fields[0] == AgentInfoField && len(fields) == 1 {
			return sourceObject
		}
	}
	return sourceUnknown
}

func assertAvailability(file string, step int, key string, proven, required []WhenSpec, label string) error {
	if len(required) == 0 {
		return nil
	}
	var missing []WhenSpec
	for _, clause := range required {
		if !slices.Contains(proven, clause) {
			missing = append(missing, clause)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	format := func(clause WhenSpec) string {
		if clause.Kind == WhenTruthy {
			return "{{" + clause.Path + "}}"
		}
		op := "=="
		if clause.Negate {
			op = "!="
		}
		return fmt.Sprintf("{{%s}} %s %s", clause.Path, op, jsonQuote(clause.Value))
	}
	missingText := make([]string, len(missing))
	allText := make([]string, len(required))
	for i, clause := range missing {
		missingText[i] = format(clause)
	}
	for i, clause := range required {
		allText[i] = format(clause)
	}
	return bail(file, step, key, fmt.Sprintf("%s is not proven available — missing producer when: %s; consumer must include: %s", label, strings.Join(missingText, ", "), strings.Join(allText, ", ")))
}

// ShellUsesInput reports whether a shell command reads the exact HWF variable.
func ShellUsesInput(command, name string) bool {
	prefix := "HWF_" + name
	for from := 0; from <= len(command); {
		index := strings.Index(command[from:], prefix)
		if index < 0 {
			return false
		}
		index += from + len(prefix)
		if index == len(command) || !isEnvNameByte(command[index]) {
			return true
		}
		from = index
	}
	return false
}

func isEnvNameByte(value byte) bool {
	return (value >= 'A' && value <= 'Z') || (value >= 'a' && value <= 'z') || (value >= '0' && value <= '9') || value == '_'
}

func assertShellHwfGuards(file string, step int, command string, opts templateOptions) error {
	names := make([]string, 0, len(opts.Inputs))
	for name := range opts.Inputs {
		names = append(names, name)
	}
	slices.Sort(names)
	for _, name := range names {
		input := opts.Inputs[name]
		if len(input.When) == 0 || !ShellUsesInput(command, input.Name) {
			continue
		}
		if err := assertAvailability(file, step, "run", opts.Proven, input.When, fmt.Sprintf("input '%s'", input.Name)); err != nil {
			return err
		}
	}
	return nil
}

func assertConditionScalar(file string, step int, key string, path TemplatePath, opts templateOptions) error {
	if sourceTypeOf(path, opts.Producers, opts.Inputs) == sourceObject {
		return bail(file, step, key, "when: rejects structured sources — use a scalar field (string, number, boolean)")
	}
	return nil
}

func assertTemplatePath(file string, step int, key string, path TemplatePath, opts templateOptions) error {
	if path.Root == "inputs" {
		if len(path.Segments) != 1 {
			return bail(file, step, key, fmt.Sprintf("unknown input '%s'", path.Segments[0]))
		}
		input, ok := opts.Inputs[path.Segments[0]]
		if !ok {
			return bail(file, step, key, fmt.Sprintf("unknown input '%s'", path.Segments[0]))
		}
		return assertAvailability(file, step, key, opts.Proven, input.When, fmt.Sprintf("input '%s'", input.Name))
	}
	if path.Root == "context" {
		if opts.RejectSensitive && len(path.Segments) > 0 && SensitiveContextKeys[path.Segments[0]] {
			return bail(file, step, key, fmt.Sprintf("returns: cannot reference context.%s", path.Segments[0]))
		}
		return assertContextPath(file, step, key, path.Segments, opts.AllowContextError)
	}
	if len(path.Segments) == 0 {
		return bail(file, step, key, "steps reference requires a step id")
	}
	producer, ok := opts.Producers[path.Segments[0]]
	if !ok {
		return bail(file, step, key, fmt.Sprintf("unknown step id '%s'", path.Segments[0]))
	}
	if opts.EarlierOnly && opts.MaxStepIndex > 0 && producer.Index >= opts.MaxStepIndex {
		return bail(file, step, key, fmt.Sprintf("forward reference to step '%s'", producer.ID))
	}
	if err := assertAvailability(file, step, key, opts.Proven, producer.When, fmt.Sprintf("step '%s' result", producer.ID)); err != nil {
		return err
	}
	return assertProducerField(file, step, key, producer, path.Segments[1:])
}

func assertTemplates(file string, step int, key, text string, opts templateOptions) error {
	for _, path := range TextTemplates(text) {
		if err := assertTemplatePath(file, step, key, path, opts); err != nil {
			return err
		}
	}
	return nil
}

func assertValueTemplates(file string, step int, key string, value any, opts templateOptions) error {
	var result error
	WalkValueStrings(value, key, func(text, path string) any {
		if result == nil {
			result = assertTemplates(file, step, path, text, opts)
		}
		return text
	})
	return result
}

func assertUsingProfile(file string, step int, key, using string, profiles map[string]bool) error {
	if strings.Contains(using, "{{") || profiles[using] {
		return nil
	}
	available := make([]string, 0, len(profiles))
	for name := range profiles {
		available = append(available, name)
	}
	slices.Sort(available)
	if len(available) == 0 {
		return bail(file, step, key, fmt.Sprintf("unknown profile '%s' (no profiles configured)", using))
	}
	return bail(file, step, key, fmt.Sprintf("unknown profile '%s' (available: %s)", using, strings.Join(available, ", ")))
}

func assertCwdEnvPane(file string, step int, action Action, opts templateOptions, key func(string) string) error {
	var cwd string
	var env map[string]string
	var pane *PaneSpec
	switch value := action.(type) {
	case AgentAction:
		cwd, env, pane = value.Cwd, value.Env, value.Pane
	case RunAction:
		cwd, env, pane = value.Cwd, value.Env, value.Pane
	}
	if cwd != "" {
		if err := assertTemplates(file, step, key("cwd"), cwd, opts); err != nil {
			return err
		}
	}
	if env != nil {
		values := make(map[string]any, len(env))
		for name, value := range env {
			values[name] = value
		}
		if err := assertValueTemplates(file, step, key("env"), values, opts); err != nil {
			return err
		}
	}
	//nolint:nestif // pane fields each have an independent template path.
	if pane != nil {
		if pane.Anchor != "" {
			if err := assertTemplates(file, step, key("pane.target"), pane.Anchor, opts); err != nil {
				return err
			}
		}
		if pane.Workspace != "" {
			if err := assertTemplates(file, step, key("pane.workspace"), pane.Workspace, opts); err != nil {
				return err
			}
		}
		if strings.Contains(pane.Open, "{{") {
			if err := assertPaneOpenTemplate(file, step, key("pane.open"), pane.Open, pane, opts); err != nil {
				return err
			}
		}
	}
	return nil
}

var paneOpenValues = map[string]bool{"tab": true, "beside": true, "below": true}

func assertPaneOpenTemplate(file string, step int, key, open string, pane *PaneSpec, opts templateOptions) error {
	path, ok := parseWholeValueTemplate(open)
	if !ok || path.Root != "inputs" || len(path.Segments) != 1 {
		return bail(file, step, key, "pane.open must reference an unconditional closed static choice input")
	}
	input, ok := opts.Inputs[path.Segments[0]]
	if !ok {
		return bail(file, step, key, fmt.Sprintf("unknown input '%s'", path.Segments[0]))
	}
	if len(input.When) > 0 {
		return bail(file, step, key, fmt.Sprintf("pane.open input '%s' must be unconditional", input.Name))
	}
	if input.Type != "choice" || input.DynamicOptions != nil || input.AllowCustom {
		return bail(file, step, key, fmt.Sprintf("pane.open input '%s' must be a closed static choice", input.Name))
	}
	if len(input.Options) == 0 {
		return bail(file, step, key, fmt.Sprintf("pane.open input '%s' has no options", input.Name))
	}
	domain := map[string]bool{}
	for _, option := range input.Options {
		if !paneOpenValues[option] {
			return bail(file, step, key, fmt.Sprintf("pane.open input '%s' options must be tab, beside, or below", input.Name))
		}
		domain[option] = true
	}
	if domain["tab"] && (pane.Anchor != "" || pane.Size != nil) {
		return bail(file, step, key, "pane.target/size are invalid when pane.open can resolve to tab")
	}
	if (domain["beside"] || domain["below"]) && pane.Workspace != "" {
		return bail(file, step, key, "pane.workspace is invalid when pane.open can resolve to beside/below")
	}
	return nil
}

func assertActionSites(file string, step int, action Action, opts templateOptions, profiles map[string]bool, prefix string) error {
	key := func(name string) string {
		if prefix == "" {
			return name
		}
		return prefix + "." + name
	}
	switch value := action.(type) {
	case AgentAction:
		if err := assertTemplates(file, step, key("agent"), value.Prompt, opts); err != nil {
			return err
		}
		if value.Using != "" {
			if err := assertTemplates(file, step, key("using"), value.Using, opts); err != nil {
				return err
			}
			if err := assertUsingProfile(file, step, key("using"), value.Using, profiles); err != nil {
				return err
			}
		}
		if value.Target != "" {
			if err := assertTemplates(file, step, key("target"), value.Target, opts); err != nil {
				return err
			}
		}
		return assertCwdEnvPane(file, step, value, opts, key)
	case RunAction:
		if value.Payload.IsArgv() {
			for i, element := range value.Payload.Argv {
				if err := assertTemplates(file, step, key(fmt.Sprintf("run[%d]", i)), element, opts); err != nil {
					return err
				}
			}
		} else if step != 0 {
			if err := assertShellHwfGuards(file, step, value.Payload.Command, opts); err != nil {
				return err
			}
		}
		return assertCwdEnvPane(file, step, value, opts, key)
	case HerdrAction:
		if value.Params != nil {
			return assertValueTemplates(file, step, key("params"), value.Params, opts)
		}
	case WorkflowAction:
		if value.Inputs != nil {
			return assertValueTemplates(file, step, key("inputs"), value.Inputs, opts)
		}
	}
	return nil
}

func assertStepTemplates(file string, index int, step Step, opts templateOptions, profiles map[string]bool) error {
	for i, clause := range step.When {
		path, ok := ParseTemplatePath(clause.Path)
		if !ok {
			continue
		}
		key := "when"
		if len(step.When) != 1 || i != 0 {
			key = fmt.Sprintf("when[%d]", i)
		}
		proven := slices.Clone(step.When[:i])
		conditionOpts := opts
		conditionOpts.Proven = proven
		if err := assertTemplatePath(file, index, key, path, conditionOpts); err != nil {
			return err
		}
		if err := assertConditionScalar(file, index, key, path, opts); err != nil {
			return err
		}
	}
	actionOpts := opts
	actionOpts.Proven = slices.Clone(step.When)
	return assertActionSites(file, index, step.Action, actionOpts, profiles, "")
}

func assertInputGuards(file string, inputs []InputSpec) error {
	earlier := map[string]InputSpec{}
	declared := map[string]bool{}
	for _, input := range inputs {
		declared[input.Name] = true
	}
	for _, input := range inputs {
		for i, clause := range input.When {
			path, ok := ParseTemplatePath(clause.Path)
			key := fmt.Sprintf("inputs.%s.when", input.Name)
			if len(input.When) > 1 {
				key = fmt.Sprintf("inputs.%s.when[%d]", input.Name, i)
			}
			if !ok || path.Root != "inputs" || len(path.Segments) != 1 {
				return bail(file, 0, key, "input when: may only reference earlier inputs")
			}
			referenced := path.Segments[0]
			prior, exists := earlier[referenced]
			if !exists {
				if referenced == input.Name || !declared[referenced] {
					return bail(file, 0, key, fmt.Sprintf("unknown input '%s'", referenced))
				}
				return bail(file, 0, key, fmt.Sprintf("forward reference to input '%s'", referenced))
			}
			if err := assertAvailability(file, 0, key, input.When[:i], prior.When, fmt.Sprintf("input '%s'", prior.Name)); err != nil {
				return err
			}
		}
		if err := assertDynamicArgvRefs(file, input, earlier, declared); err != nil {
			return err
		}
		earlier[input.Name] = input
	}
	return nil
}

func assertDynamicArgvRefs(file string, input InputSpec, earlier map[string]InputSpec, declared map[string]bool) error {
	if input.DynamicOptions == nil {
		return nil
	}
	for i, element := range input.DynamicOptions.Run {
		key := fmt.Sprintf("inputs.%s.options.run[%d]", input.Name, i)
		for _, path := range TextTemplates(element) {
			if path.Root != "inputs" || len(path.Segments) != 1 {
				return bail(file, 0, key, DynamicArgvRootRule)
			}
			referenced := path.Segments[0]
			if referenced == input.Name {
				return bail(file, 0, key, fmt.Sprintf("self reference to input '%s'", referenced))
			}
			prior, ok := earlier[referenced]
			if !ok {
				if !declared[referenced] {
					return bail(file, 0, key, fmt.Sprintf("unknown input '%s'", referenced))
				}
				return bail(file, 0, key, fmt.Sprintf("forward reference to input '%s'", referenced))
			}
			if err := assertAvailability(file, 0, key, input.When, prior.When, fmt.Sprintf("input '%s'", referenced)); err != nil {
				return err
			}
		}
	}
	return nil
}

func buildProducers(steps []Step, childReturns map[string]*ReturnsSpec) map[string]stepProducer {
	result := map[string]stepProducer{}
	for i, step := range steps {
		producer, ok := classifyProducer(step, i+1, childReturns[step.ID])
		if ok {
			result[step.ID] = producer
		}
	}
	return result
}

// AssertWorkflowReferences validates references that require a loaded child graph.
func AssertWorkflowReferences(file string, workflow LoadedWorkflow, childReturns map[string]*ReturnsSpec, profiles map[string]bool) (map[string]stepProducer, error) {
	if err := assertUniqueStepIDs(file, workflow.Steps); err != nil {
		return nil, err
	}
	if err := assertInputGuards(file, workflow.Inputs); err != nil {
		return nil, err
	}
	producers := buildProducers(workflow.Steps, childReturns)
	inputs := make(map[string]InputSpec, len(workflow.Inputs))
	for _, input := range workflow.Inputs {
		inputs[input.Name] = input
	}
	for i, step := range workflow.Steps {
		if err := assertStepTemplates(file, i+1, step, templateOptions{
			Producers: producers, Inputs: inputs, EarlierOnly: true, MaxStepIndex: i + 1,
		}, profiles); err != nil {
			return nil, err
		}
	}
	//nolint:nestif // return templates have scalar and named-map forms.
	if workflow.Returns != nil {
		opts := templateOptions{Producers: producers, Inputs: inputs, RejectSensitive: true}
		if workflow.Returns.Template != "" {
			if err := assertTemplates(file, 0, "returns", workflow.Returns.Template, opts); err != nil {
				return nil, err
			}
		} else {
			for _, field := range workflow.Returns.Fields {
				if err := assertTemplates(file, 0, "returns."+field.Name, field.Template, opts); err != nil {
					return nil, err
				}
			}
		}
	}
	if workflow.OnFailure != nil {
		if err := assertActionSites(file, 0, workflow.OnFailure, templateOptions{
			Producers: producers, Inputs: inputs, AllowContextError: true,
		}, profiles, "on_failure"); err != nil {
			return nil, err
		}
	}
	return producers, nil
}

// AssertChildInputContract checks a workflow invocation without claiming to
// know values that will only exist after the parent runs.
func AssertChildInputContract(file string, step int, passed map[string]string, child LoadedWorkflow, producers map[string]stepProducer, parentInputs []InputSpec, profiles map[string]bool, proven []WhenSpec) error {
	declared := map[string]InputSpec{}
	for _, input := range child.Inputs {
		declared[input.Name] = input
	}
	parentByName := map[string]InputSpec{}
	for _, input := range parentInputs {
		parentByName[input.Name] = input
	}
	known := map[string]any{}
	passedNames := make([]string, 0, len(passed))
	for name := range passed {
		passedNames = append(passedNames, name)
	}
	slices.Sort(passedNames)
	for _, name := range passedNames {
		if _, ok := declared[name]; !ok {
			return bail(file, step, "inputs."+name, fmt.Sprintf("unknown child input '%s'", name))
		}
	}
	for _, input := range child.Inputs {
		value, supplied := passed[input.Name]
		if !supplied && input.Default != nil {
			value, supplied = *input.Default, true
		}
		if !supplied && !inputProvablyInactive(input, known) {
			return bail(file, step, "inputs."+input.Name, fmt.Sprintf("missing required child input '%s'", input.Name))
		}
		if supplied && !strings.Contains(value, "{{") && (len(input.When) == 0 || EvaluateWhen(input.When, TemplateNamespace{Inputs: known})) {
			known[input.Name] = value
		}
	}
	for _, name := range passedNames {
		input := declared[name]
		if err := assertChildInputValue(file, step, name, passed[name], input, producers, parentByName, profiles, proven); err != nil {
			return err
		}
	}
	return nil
}

func inputProvablyInactive(input InputSpec, known map[string]any) bool {
	if len(input.When) == 0 {
		return false
	}
	for _, clause := range input.When {
		if !strings.HasPrefix(clause.Path, "inputs.") {
			return false
		}
		if _, ok := known[strings.TrimPrefix(clause.Path, "inputs.")]; !ok {
			return false
		}
	}
	return !EvaluateWhen(input.When, TemplateNamespace{Inputs: known})
}

func assertChildInputValue(file string, step int, name, raw string, input InputSpec, producers map[string]stepProducer, parentInputs map[string]InputSpec, profiles map[string]bool, proven []WhenSpec) error {
	key := "inputs." + name
	opts := templateOptions{Producers: producers, Inputs: parentInputs, EarlierOnly: true, MaxStepIndex: step, Proven: proven}
	if path, ok := parseWholeValueTemplate(raw); ok {
		if err := assertTemplatePath(file, step, key, path, opts); err != nil {
			return err
		}
		switch sourceTypeOf(path, producers, parentInputs) {
		case sourceObject, sourceNumber, sourceBool:
			return bail(file, step, key, fmt.Sprintf("child input '%s' must resolve to text (source type %s)", name, sourceTypeOf(path, producers, parentInputs)))
		}
	} else if err := assertTemplates(file, step, key, raw, opts); err != nil {
		return err
	}
	if strings.Contains(raw, "{{") {
		return nil
	}
	if input.Type == "profile" && !profiles[raw] {
		return bail(file, step, key, fmt.Sprintf("child input '%s' must name a merged profile", name))
	}
	if input.Type == "choice" && len(input.Options) > 0 && !input.AllowCustom && !slices.Contains(input.Options, raw) {
		return bail(file, step, key, fmt.Sprintf("child input '%s' must be one of: %s", name, strings.Join(input.Options, ", ")))
	}
	return nil
}

// WorkflowChildNames returns direct workflow action targets, including recovery.
func WorkflowChildNames(workflow LoadedWorkflow) []string {
	var names []string
	for _, step := range workflow.Steps {
		if action, ok := step.Action.(WorkflowAction); ok {
			names = append(names, action.Name)
		}
	}
	if action, ok := workflow.OnFailure.(WorkflowAction); ok {
		names = append(names, action.Name)
	}
	return names
}
