package workflow

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/aorumbayev/herdr-workflows/internal/caps"
	"github.com/aorumbayev/herdr-workflows/internal/config"
	"gopkg.in/yaml.v3"
)

// SchemaPointer returns the language-server schema pointer for this build.
func SchemaPointer() string {
	return "# yaml-language-server: $schema=" + config.WorkflowSchemaURL()
}

var schemaPointerRE = regexp.MustCompile(`^#\s*yaml-language-server:\s*\$schema=\S+\s*$`)

// WithPinnedSchemaPointer replaces any existing workflow schema pointer.
func WithPinnedSchemaPointer(text string) string {
	pointer := SchemaPointer()
	if text == "" {
		return pointer + "\n"
	}
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	kept := make([]string, 0, len(lines))
	for _, line := range lines {
		if schemaPointerRE.MatchString(line) {
			continue
		}
		kept = append(kept, line)
	}
	if len(kept) == len(lines)-1 && lines[0] == pointer {
		return text
	}
	return pointer + "\n" + strings.Join(kept, "\n")
}

// DumpWorkflow emits reviewable YAML from a parsed Document.
func DumpWorkflow(doc Document) (string, error) {
	entries := []dumpEntry{{key: "version", value: dumpNode(doc.Version)}}
	if doc.Title != "" {
		entries = append(entries, dumpEntry{key: "title", value: dumpNode(doc.Title)})
	}
	if doc.Description != "" {
		entries = append(entries, dumpEntry{key: "description", value: dumpNode(doc.Description)})
	}
	if doc.Hidden {
		entries = append(entries, dumpEntry{key: "hidden", value: dumpNode(true)})
	}
	if len(doc.Inputs) > 0 {
		inputEntries := make([]dumpEntry, 0, len(doc.Inputs))
		for _, input := range doc.Inputs {
			inputEntries = append(inputEntries, dumpEntry{key: input.Name, value: dumpInputNode(input.Value)})
		}
		entries = append(entries, dumpEntry{key: "inputs", value: dumpMapping(inputEntries)})
	}
	if doc.Returns != nil {
		if doc.Returns.Template != "" {
			entries = append(entries, dumpEntry{key: "returns", value: dumpNode(doc.Returns.Template)})
		} else {
			returnEntries := make([]dumpEntry, 0, len(doc.Returns.Fields))
			for _, field := range doc.Returns.Fields {
				returnEntries = append(returnEntries, dumpEntry{key: field.Name, value: dumpNode(field.Template)})
			}
			entries = append(entries, dumpEntry{key: "returns", value: dumpMapping(returnEntries)})
		}
	}
	stepNodes := make([]*yaml.Node, len(doc.Steps))
	for i, step := range doc.Steps {
		stepNodes[i] = dumpStepNode(step)
	}
	entries = append(entries, dumpEntry{key: "steps", value: dumpSequence(stepNodes)})
	if doc.OnFailure != nil {
		entries = append(entries, dumpEntry{key: "on_failure", value: dumpMapping(dumpActionEntries(doc.OnFailure))})
	}
	data, err := yaml.Marshal(dumpMapping(entries))
	if err != nil {
		return "", err
	}
	return SchemaPointer() + "\n" + string(data), nil
}

type dumpEntry struct {
	key   string
	value *yaml.Node
}

func dumpNode(value any) *yaml.Node {
	data, err := yaml.Marshal(value)
	if err != nil {
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: fmt.Sprint(value)}
	}
	var document yaml.Node
	if yaml.Unmarshal(data, &document) != nil || len(document.Content) == 0 {
		return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: fmt.Sprint(value)}
	}
	return document.Content[0]
}

func dumpMapping(entries []dumpEntry) *yaml.Node {
	node := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
	for _, entry := range entries {
		node.Content = append(node.Content, dumpNode(entry.key), entry.value)
	}
	return node
}

func dumpSequence(values []*yaml.Node) *yaml.Node {
	node := &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
	node.Content = append(node.Content, values...)
	return node
}

func dumpInputNode(value RawInputValue) *yaml.Node {
	switch input := value.(type) {
	case RawInputShorthand:
		return dumpNode(string(input))
	case RawInputStatic:
		values := make([]*yaml.Node, len(input))
		for i, option := range input {
			values[i] = dumpNode(option)
		}
		return dumpSequence(values)
	case *RawInputMap:
		entries := []dumpEntry{}
		if input.Type != "" {
			entries = append(entries, dumpEntry{key: "type", value: dumpNode(input.Type)})
		}
		if input.Description != nil {
			entries = append(entries, dumpEntry{key: "description", value: dumpNode(*input.Description)})
		}
		if input.Default != nil {
			entries = append(entries, dumpEntry{key: "default", value: dumpNode(*input.Default)})
		}
		if input.Options != nil {
			if input.Options.Dynamic != nil {
				args := make([]*yaml.Node, len(input.Options.Dynamic.Run))
				for i, arg := range input.Options.Dynamic.Run {
					args[i] = dumpNode(arg)
				}
				entries = append(entries, dumpEntry{key: "options", value: dumpMapping([]dumpEntry{{key: "run", value: dumpSequence(args)}})})
			} else {
				options := make([]*yaml.Node, len(input.Options.Static))
				for i, option := range input.Options.Static {
					options[i] = dumpNode(option)
				}
				entries = append(entries, dumpEntry{key: "options", value: dumpSequence(options)})
			}
		}
		if len(input.When) == 1 {
			entries = append(entries, dumpEntry{key: "when", value: dumpNode(input.When[0])})
		} else if len(input.When) > 1 {
			clauses := make([]*yaml.Node, len(input.When))
			for i, clause := range input.When {
				clauses[i] = dumpNode(clause)
			}
			entries = append(entries, dumpEntry{key: "when", value: dumpSequence(clauses)})
		}
		if input.AllowCustom != nil {
			entries = append(entries, dumpEntry{key: "allow_custom", value: dumpNode(*input.AllowCustom)})
		}
		if input.MinLength != nil {
			entries = append(entries, dumpEntry{key: "min_length", value: dumpNode(*input.MinLength)})
		}
		return dumpMapping(entries)
	default:
		return dumpNode(nil)
	}
}

func dumpStepNode(step Step) *yaml.Node {
	entries := dumpActionEntries(step.Action)
	if step.ID != "" {
		entries = append(entries, dumpEntry{key: "id", value: dumpNode(step.ID)})
	}
	if len(step.When) == 1 {
		entries = append(entries, dumpEntry{key: "when", value: dumpNode(formatWhen(step.When[0]))})
	} else if len(step.When) > 1 {
		clauses := make([]*yaml.Node, len(step.When))
		for j, clause := range step.When {
			clauses[j] = dumpNode(formatWhen(clause))
		}
		entries = append(entries, dumpEntry{key: "when", value: dumpSequence(clauses)})
	}
	if step.ContinueOnError {
		entries = append(entries, dumpEntry{key: "continue_on_error", value: dumpNode(true)})
	}
	return dumpMapping(entries)
}

func formatWhen(clause WhenSpec) string {
	if clause.Kind == WhenTruthy {
		return "{{" + clause.Path + "}}"
	}
	op := "=="
	if clause.Negate {
		op = "!="
	}
	return fmt.Sprintf("{{%s}} %s %q", clause.Path, op, clause.Value)
}

func dumpActionEntries(action Action) []dumpEntry {
	entries := []dumpEntry{}
	switch value := action.(type) {
	case AgentAction:
		entries = append(entries, dumpEntry{key: "agent", value: dumpNode(value.Prompt)})
		if value.Using != "" {
			entries = append(entries, dumpEntry{key: "using", value: dumpNode(value.Using)})
		}
		if value.Target != "" {
			entries = append(entries, dumpEntry{key: "target", value: dumpNode(value.Target)})
		}
		entries = append(entries, dumpCommonActionFields(value.Cwd, value.Env, value.Pane, value.Background, value.Timeout)...)
		if value.Expect != nil {
			expect := []dumpEntry{{key: "one_of", value: dumpNode(value.Expect.OneOf)}}
			if len(value.Expect.Require) > 0 {
				expect = append(expect, dumpEntry{key: "require", value: dumpNode(value.Expect.Require)})
			}
			entries = append(entries, dumpEntry{key: "expect", value: dumpMapping(expect)})
		}
	case RunAction:
		if value.Payload.IsArgv() {
			entries = append(entries, dumpEntry{key: "run", value: dumpNode(value.Payload.Argv)})
		} else {
			entries = append(entries, dumpEntry{key: "run", value: dumpNode(value.Payload.Command)})
			if value.Payload.Shell != "" {
				entries = append(entries, dumpEntry{key: "shell", value: dumpNode(value.Payload.Shell)})
			}
		}
		entries = append(entries, dumpCommonActionFields(value.Cwd, value.Env, value.Pane, value.Background, value.Timeout)...)
		if value.ReadyWhen != "" {
			entries = append(entries, dumpEntry{key: "ready_when", value: dumpNode("/" + value.ReadyWhen + "/")})
		}
		if value.Retry != nil {
			entries = append(entries, dumpEntry{key: "retry", value: dumpRetryNode(value.Retry)})
		}
		if len(value.SuccessCodes) > 0 {
			entries = append(entries, dumpEntry{key: "success_codes", value: dumpNode(value.SuccessCodes)})
		}
	case HerdrAction:
		entries = append(entries, dumpEntry{key: "herdr", value: dumpNode(value.Method)})
		if value.Params != nil {
			entries = append(entries, dumpEntry{key: "params", value: dumpNode(value.Params)})
		}
		if value.Retry != nil {
			entries = append(entries, dumpEntry{key: "retry", value: dumpRetryNode(value.Retry)})
		}
	case WorkflowAction:
		entries = append(entries, dumpEntry{key: "workflow", value: dumpNode(value.Name)})
		if value.Inputs != nil {
			entries = append(entries, dumpEntry{key: "inputs", value: dumpNode(value.Inputs)})
		}
	}
	return entries
}

func dumpCommonActionFields(cwd string, env map[string]string, pane *PaneSpec, background bool, timeout time.Duration) []dumpEntry {
	entries := []dumpEntry{}
	if cwd != "" {
		entries = append(entries, dumpEntry{key: "cwd", value: dumpNode(cwd)})
	}
	if env != nil {
		keys := make([]string, 0, len(env))
		for key := range env {
			keys = append(keys, key)
		}
		slices.Sort(keys)
		values := make([]dumpEntry, 0, len(keys))
		for _, key := range keys {
			values = append(values, dumpEntry{key: key, value: dumpNode(env[key])})
		}
		entries = append(entries, dumpEntry{key: "env", value: dumpMapping(values)})
	}
	if pane != nil {
		entries = append(entries, dumpEntry{key: "pane", value: dumpPaneNode(pane)})
	}
	if background {
		entries = append(entries, dumpEntry{key: "background", value: dumpNode(true)})
	}
	if timeout != 0 {
		entries = append(entries, dumpEntry{key: "timeout", value: dumpNode(timeout.String())})
	}
	return entries
}

func dumpPaneNode(pane *PaneSpec) *yaml.Node {
	entries := []dumpEntry{{key: "open", value: dumpNode(pane.Open)}}
	if pane.Anchor != "" {
		entries = append(entries, dumpEntry{key: "target", value: dumpNode(pane.Anchor)})
	}
	if pane.Workspace != "" {
		entries = append(entries, dumpEntry{key: "workspace", value: dumpNode(pane.Workspace)})
	}
	if pane.Size != nil {
		entries = append(entries, dumpEntry{key: "size", value: dumpNode(*pane.Size)})
	}
	if pane.Focus != nil {
		entries = append(entries, dumpEntry{key: "focus", value: dumpNode(*pane.Focus)})
	}
	if pane.Name != "" {
		entries = append(entries, dumpEntry{key: "name", value: dumpNode(pane.Name)})
	}
	if pane.Close != "" {
		entries = append(entries, dumpEntry{key: "close", value: dumpNode(pane.Close)})
	}
	return dumpMapping(entries)
}

func dumpRetryNode(retry *RetrySpec) *yaml.Node {
	entries := []dumpEntry{{key: "attempts", value: dumpNode(retry.Attempts)}}
	if retry.Delay != 0 {
		entries = append(entries, dumpEntry{key: "delay", value: dumpNode(retry.Delay.String())})
	}
	return dumpMapping(entries)
}

// ParseDynamicChoiceStdout normalizes one choice per output line.
func ParseDynamicChoiceStdout(stdout string) []string {
	seen := map[string]bool{}
	var choices []string
	for _, line := range strings.Split(strings.ReplaceAll(stdout, "\r\n", "\n"), "\n") {
		value := strings.TrimSpace(line)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		choices = append(choices, value)
	}
	return choices
}

const (
	dynamicChoiceTimeout = 10 * time.Second
	dynamicChoiceMax     = 1000
	stderrTail           = 500
)

type captureOutcome struct {
	stdout   string
	stderr   string
	exitCode int
	timedOut bool
}

type captureBudget struct {
	total  atomic.Int64
	limit  int64
	source string
}

func (b *captureBudget) add(size int) error {
	total := b.total.Add(int64(size))
	if total > b.limit {
		return &caps.CaptureLimitError{Source: b.source, Bytes: int(total), Limit: int(b.limit)}
	}
	return nil
}

func readCapture(reader io.Reader, budget *captureBudget, overflow chan<- error) ([]byte, error) {
	var result bytes.Buffer
	buffer := make([]byte, 32*1024)
	for {
		n, err := reader.Read(buffer)
		if n > 0 {
			if budgetErr := budget.add(n); budgetErr != nil {
				overflow <- budgetErr
				return nil, nil
			}
			_, _ = result.Write(buffer[:n])
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return result.Bytes(), nil
			}
			return nil, err
		}
	}
}

func killProcessGroup(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); err != nil {
		_ = cmd.Process.Kill()
	}
}

func runDynamicCommand(ctx context.Context, argv []string, repoRoot, source string) (captureOutcome, error) {
	if len(argv) == 0 {
		return captureOutcome{}, fmt.Errorf("empty dynamic choice command")
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = repoRoot
	cmd.Env = os.Environ()
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return captureOutcome{}, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return captureOutcome{}, err
	}
	if err := cmd.Start(); err != nil {
		return captureOutcome{}, err
	}
	overflow := make(chan error, 2)
	budget := &captureBudget{limit: caps.CaptureByteLimit, source: source}
	stdoutDone := make(chan []byte, 1)
	stderrDone := make(chan []byte, 1)
	go func() {
		value, readErr := readCapture(stdout, budget, overflow)
		if readErr != nil {
			overflow <- readErr
		}
		stdoutDone <- value
	}()
	go func() {
		value, readErr := readCapture(stderr, budget, overflow)
		if readErr != nil {
			overflow <- readErr
		}
		stderrDone <- value
	}()

	stop := make(chan struct{})
	stopped := make(chan struct{})
	reason := make(chan error, 1)
	go func() {
		defer close(stopped)
		select {
		case err := <-overflow:
			killProcessGroup(cmd)
			reason <- err
		case <-ctx.Done():
			killProcessGroup(cmd)
			reason <- context.DeadlineExceeded
		case <-stop:
		}
	}()
	stdoutBytes := <-stdoutDone
	stderrBytes := <-stderrDone
	var stopErr error
	select {
	case stopErr = <-overflow:
		killProcessGroup(cmd)
	default:
	}
	close(stop)
	waitErr := cmd.Wait()
	<-stopped
	if stopErr == nil {
		select {
		case stopErr = <-reason:
		default:
		}
	}
	out := captureOutcome{timedOut: errors.Is(stopErr, context.DeadlineExceeded)}
	out.stdout = string(stdoutBytes)
	out.stderr = string(stderrBytes)
	if stopErr != nil && !out.timedOut {
		return captureOutcome{}, stopErr
	}
	if out.timedOut {
		return out, nil
	}
	if waitErr == nil {
		return out, nil
	}
	var exitErr *exec.ExitError
	if errors.As(waitErr, &exitErr) {
		out.exitCode = exitErr.ExitCode()
		return out, nil
	}
	return captureOutcome{}, waitErr
}

// ResolveDynamicChoices executes one validated direct-argv choice command.
func ResolveDynamicChoices(ctx context.Context, file, name string, dynamic DynamicChoice, repoRoot string, values map[string]string) ([]string, error) {
	ns := TemplateNamespace{Inputs: map[string]any{}, Steps: map[string]any{}, Context: map[string]any{}}
	for key, value := range values {
		ns.Inputs[key] = value
	}
	argv := make([]string, len(dynamic.Run))
	for i, element := range dynamic.Run {
		argv[i] = SubstituteText(element, ns)
	}
	commandCtx, cancel := context.WithTimeout(ctx, dynamicChoiceTimeout)
	defer cancel()
	outcome, err := runDynamicCommand(commandCtx, argv, repoRoot, "inputs."+name+" dynamic choice")
	if err != nil {
		return nil, err
	}
	if outcome.timedOut {
		return nil, bail(file, 0, "inputs."+name, "dynamic choice failed: timed out after 10s")
	}
	if outcome.exitCode != 0 {
		tail := strings.TrimSpace(outcome.stderr)
		if len(tail) > stderrTail {
			tail = tail[len(tail)-stderrTail:]
		}
		if tail == "" {
			tail = fmt.Sprintf("exit %d", outcome.exitCode)
		}
		return nil, bail(file, 0, "inputs."+name, "dynamic choice failed: "+tail)
	}
	choices := ParseDynamicChoiceStdout(outcome.stdout)
	if len(choices) == 0 {
		return nil, bail(file, 0, "inputs."+name, "dynamic choice produced no options")
	}
	if len(choices) > dynamicChoiceMax {
		return nil, bail(file, 0, "inputs."+name, fmt.Sprintf("dynamic choice produced %d options (limit %d)", len(choices), dynamicChoiceMax))
	}
	return choices, nil
}

type CollectedInputs struct {
	Values  map[string]string
	Domains map[string][]string
}

type InputPrompt struct {
	Index   int
	Spec    InputSpec
	Options []string
}

type CurrentResult struct {
	Prompt    *InputPrompt
	Done      bool
	Cancelled bool
	Err       error
}

type InputSessionOptions struct {
	Specs          []InputSpec
	File           string
	Config         config.Config
	RepoRoot       string
	Answers        map[string]string
	Domains        map[string][]string
	ResolveDynamic *bool
}

// InputSession collects active inputs in declaration order.
type InputSession struct {
	mu              sync.Mutex
	opts            InputSessionOptions
	values          map[string]string
	domains         map[string][]string
	suppliedDomains map[string]bool
	usedDomains     map[string]bool
	cursor          int
	pending         *InputPrompt
	generation      uint64
	cancel          context.CancelFunc
}

func NewInputSession(opts InputSessionOptions) *InputSession {
	return &InputSession{
		opts:            opts,
		values:          cloneStrings(opts.Answers),
		domains:         cloneStringSlices(opts.Domains),
		suppliedDomains: keySet(opts.Domains),
		usedDomains:     map[string]bool{},
	}
}

func cloneStrings(values map[string]string) map[string]string {
	result := map[string]string{}
	for key, value := range values {
		result[key] = value
	}
	return result
}

func cloneStringSlices(values map[string][]string) map[string][]string {
	result := map[string][]string{}
	for key, value := range values {
		result[key] = slices.Clone(value)
	}
	return result
}

func keySet(values map[string][]string) map[string]bool {
	result := map[string]bool{}
	for key := range values {
		result[key] = true
	}
	return result
}

func (s *InputSession) nextActiveInput(from int) (int, InputSpec, bool) {
	ns := TemplateNamespace{Inputs: map[string]any{}, Steps: map[string]any{}, Context: map[string]any{}}
	for name, value := range s.values {
		ns.Inputs[name] = value
	}
	for i := from; i < len(s.opts.Specs); i++ {
		input := s.opts.Specs[i]
		if EvaluateWhen(input.When, ns) {
			return i, input, true
		}
	}
	return 0, InputSpec{}, false
}

func (s *InputSession) previousActiveIndex(before int) (int, bool) {
	kept := map[string]string{}
	var last int
	found := false
	for i := 0; i < before; i++ {
		ns := TemplateNamespace{Inputs: map[string]any{}, Steps: map[string]any{}, Context: map[string]any{}}
		for name, value := range kept {
			ns.Inputs[name] = value
		}
		input := s.opts.Specs[i]
		if !EvaluateWhen(input.When, ns) {
			continue
		}
		if value, ok := s.values[input.Name]; ok {
			kept[input.Name] = value
		}
		last, found = i, true
	}
	return last, found
}

func (s *InputSession) optionsFor(input InputSpec) []string {
	if options, ok := s.domains[input.Name]; ok {
		return options
	}
	return input.Options
}

func (s *InputSession) resolveOptions(ctx context.Context, input InputSpec) ([]string, error) {
	if input.Type == "profile" {
		options := config.ProfileNames(s.opts.Config)
		if len(options) == 0 {
			global, _ := config.GlobalConfigPath(nil)
			return nil, fmt.Errorf("input '%s': %s", input.Name, config.NoProfilesConfiguredMessage(global, config.RepoConfigPath(s.opts.RepoRoot)))
		}
		return options, nil
	}
	if input.Type != "choice" {
		return nil, nil
	}
	if options := s.optionsFor(input); options != nil {
		return options, nil
	}
	if input.DynamicOptions == nil {
		return nil, fmt.Errorf("input '%s': choice produced no options", input.Name)
	}
	if s.opts.ResolveDynamic != nil && !*s.opts.ResolveDynamic {
		return nil, fmt.Errorf("input '%s': missing launch payload domain snapshot", input.Name)
	}
	return ResolveDynamicChoices(ctx, s.opts.File, input.Name, *input.DynamicOptions, s.opts.RepoRoot, s.values)
}

func validateInputValue(input InputSpec, value string, options []string) error {
	if input.MinLength != nil && utf8.RuneCountInString(value) < *input.MinLength {
		return fmt.Errorf("input '%s' must be at least %d characters", input.Name, *input.MinLength)
	}
	if input.Type == "profile" && !slices.Contains(options, value) {
		return fmt.Errorf("input '%s' must be one of: %s", input.Name, strings.Join(options, ", "))
	}
	if input.Type == "choice" && options != nil && !input.AllowCustom && !slices.Contains(options, value) {
		return fmt.Errorf("input '%s' must be one of: %s", input.Name, strings.Join(options, ", "))
	}
	return nil
}

// Current resolves the next prompt. A later call or CancelPending invalidates
// a dynamic choice resolution that is still in progress.
func (s *InputSession) Current(ctx context.Context) CurrentResult {
	s.mu.Lock()
	if s.cancel != nil {
		s.cancel()
	}
	requestCtx, cancel := context.WithCancel(ctx)
	s.cancel = cancel
	s.generation++
	token := s.generation
	index, input, ok := s.nextActiveInput(s.cursor)
	if !ok {
		s.pending = nil
		s.mu.Unlock()
		return CurrentResult{Done: true}
	}
	s.cursor = index
	if _, exists := s.domains[input.Name]; exists {
		s.usedDomains[input.Name] = true
	}
	s.mu.Unlock()

	options, err := s.resolveOptions(requestCtx, input)
	s.mu.Lock()
	defer s.mu.Unlock()
	if token != s.generation || requestCtx.Err() != nil {
		return CurrentResult{Cancelled: true}
	}
	if err != nil {
		return CurrentResult{Err: err}
	}
	if input.Type == "choice" && len(options) == 0 {
		return CurrentResult{Err: fmt.Errorf("input '%s': choice produced no options", input.Name)}
	}
	if input.Type == "profile" && len(options) == 0 {
		return CurrentResult{Err: fmt.Errorf("input '%s': no profiles configured", input.Name)}
	}
	if options != nil && input.DynamicOptions != nil {
		s.domains[input.Name] = slices.Clone(options)
	}
	if _, exists := s.domains[input.Name]; exists {
		s.usedDomains[input.Name] = true
	}
	s.pending = &InputPrompt{Index: index, Spec: input, Options: slices.Clone(options)}
	return CurrentResult{Prompt: s.pending}
}

// Answer accepts the current input and invalidates later answers and domains.
func (s *InputSession) Answer(value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pending == nil {
		return fmt.Errorf("no active input")
	}
	if err := validateInputValue(s.pending.Spec, value, s.pending.Options); err != nil {
		return err
	}
	for _, later := range s.opts.Specs[s.pending.Index+1:] {
		delete(s.values, later.Name)
		if !s.suppliedDomains[later.Name] {
			delete(s.domains, later.Name)
		}
	}
	s.values[s.pending.Spec.Name] = value
	s.cursor = s.pending.Index + 1
	s.pending = nil
	return nil
}

// Back reopens the last active input.
func (s *InputSession) Back() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	previous, ok := s.previousActiveIndex(s.cursor)
	if !ok {
		return false
	}
	s.generation++
	if s.cancel != nil {
		s.cancel()
	}
	for _, later := range s.opts.Specs[previous+1:] {
		delete(s.values, later.Name)
		delete(s.domains, later.Name)
	}
	s.cursor = previous
	s.pending = nil
	return true
}

// CancelPending invalidates a dynamic choice resolution.
func (s *InputSession) CancelPending() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.generation++
	if s.cancel != nil {
		s.cancel()
	}
	s.pending = nil
}

func (s *InputSession) Values() map[string]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return cloneStrings(s.values)
}

func (s *InputSession) Domains() map[string][]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return cloneStringSlices(s.domains)
}

// Result returns collected values when all active inputs are complete.
func (s *InputSession) Result() (CollectedInputs, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for name := range s.suppliedDomains {
		if !s.usedDomains[name] {
			return CollectedInputs{}, fmt.Errorf("launch payload domain '%s' belongs to an inactive or non-dynamic input", name)
		}
	}
	if _, _, ok := s.nextActiveInput(s.cursor); ok {
		return CollectedInputs{}, fmt.Errorf("input collection is incomplete")
	}
	return CollectedInputs{Values: cloneStrings(s.values), Domains: cloneStringSlices(s.domains)}, nil
}

// CompleteFromProvided runs the session without a prompt.
func (s *InputSession) CompleteFromProvided(ctx context.Context, provided map[string]string) (CollectedInputs, error) {
	declared := map[string]bool{}
	for _, input := range s.opts.Specs {
		declared[input.Name] = true
	}
	for name := range provided {
		if !declared[name] {
			return CollectedInputs{}, fmt.Errorf("unknown input '%s'", name)
		}
	}
	for name := range s.opts.Domains {
		valid := false
		for _, input := range s.opts.Specs {
			if input.Name == name && input.Type == "choice" && input.DynamicOptions != nil {
				valid = true
				break
			}
		}
		if !valid {
			return CollectedInputs{}, fmt.Errorf("launch payload domain '%s' must name a declared dynamic choice input", name)
		}
	}
	for {
		current := s.Current(ctx)
		if current.Cancelled {
			return CollectedInputs{}, fmt.Errorf("input collection cancelled")
		}
		if current.Err != nil {
			return CollectedInputs{}, current.Err
		}
		if current.Done {
			break
		}
		name := current.Prompt.Spec.Name
		value, supplied := provided[name]
		if !supplied {
			if current.Prompt.Spec.Default == nil {
				return CollectedInputs{}, fmt.Errorf("missing input '%s' (--input %s=…)", name, name)
			}
			value = *current.Prompt.Spec.Default
		}
		if err := s.Answer(value); err != nil {
			return CollectedInputs{}, err
		}
	}
	for name := range provided {
		if _, ok := s.Values()[name]; !ok {
			return CollectedInputs{}, fmt.Errorf("input '%s' is inactive under current answers", name)
		}
	}
	return s.Result()
}

func resolveInput(file, name string, raw RawInputValue) (InputSpec, error) {
	if shorthand, ok := raw.(RawInputShorthand); ok {
		if shorthand != "text" && shorthand != "profile" {
			return InputSpec{}, bail(file, 0, "inputs."+name, "Invalid input")
		}
		return InputSpec{Name: name, Type: string(shorthand)}, nil
	}
	if static, ok := raw.(RawInputStatic); ok {
		return InputSpec{Name: name, Type: "choice", Options: slices.Clone(static)}, nil
	}
	declaration, ok := raw.(*RawInputMap)
	if !ok {
		return InputSpec{}, bail(file, 0, "inputs."+name, "Invalid input")
	}
	typ := declaration.Type
	if typ == "" {
		if declaration.Options != nil {
			typ = "choice"
		} else {
			typ = "text"
		}
	}
	input := InputSpec{Name: name, Type: typ}
	if declaration.Description != nil {
		input.Description = *declaration.Description
	}
	input.Default = declaration.Default
	input.AllowCustom = declaration.AllowCustom != nil && *declaration.AllowCustom
	input.MinLength = declaration.MinLength
	for i, clause := range declaration.When {
		key := fmt.Sprintf("inputs.%s.when", name)
		if declaration.WhenList {
			key = fmt.Sprintf("inputs.%s.when[%d]", name, i)
		}
		parsed, err := ParseWhenClause(file, 0, key, clause)
		if err != nil {
			return InputSpec{}, err
		}
		input.When = append(input.When, parsed)
	}
	if declaration.Options != nil {
		if declaration.Options.Dynamic != nil {
			input.DynamicOptions = declaration.Options.Dynamic
		} else {
			input.Options = slices.Clone(declaration.Options.Static)
		}
	}
	return input, nil
}

func inputsOf(file string, raw Document) ([]InputSpec, error) {
	result := make([]InputSpec, 0, len(raw.Inputs))
	for _, named := range raw.Inputs {
		input, err := resolveInput(file, named.Name, named.Value)
		if err != nil {
			return nil, err
		}
		result = append(result, input)
	}
	return result, nil
}

func inputIsUsed(name string, workflow Definition) bool {
	for _, path := range TemplateRefs(workflow.Steps, workflow.Returns, workflow.OnFailure) {
		if path.Root == "inputs" && len(path.Segments) > 0 && path.Segments[0] == name {
			return true
		}
	}
	for _, input := range workflow.Inputs {
		for _, clause := range input.When {
			parts := strings.Split(clause.Path, ".")
			if len(parts) >= 2 && parts[0] == "inputs" && parts[1] == name {
				return true
			}
		}
		if input.DynamicOptions != nil && slices.Contains(DynamicChoiceInputRefs(*input.DynamicOptions), name) {
			return true
		}
	}
	for _, step := range workflow.Steps {
		if action, ok := step.Action.(RunAction); ok && !action.Payload.IsArgv() && ShellUsesInput(action.Payload.Command, name) {
			return true
		}
	}
	if action, ok := workflow.OnFailure.(RunAction); ok && !action.Payload.IsArgv() && ShellUsesInput(action.Payload.Command, name) {
		return true
	}
	return false
}

func assertInputsUsed(file string, workflow Definition) error {
	for _, input := range workflow.Inputs {
		if !inputIsUsed(input.Name, workflow) {
			return bail(file, 0, "inputs."+input.Name, "unused input")
		}
	}
	return nil
}

func finalizeInputs(file string, inputs []InputSpec) error {
	for _, input := range inputs {
		if input.Type != "choice" {
			continue
		}
		if input.DynamicOptions == nil && len(input.Options) == 0 {
			return bail(file, 0, "inputs."+input.Name, "choice produced no options")
		}
		if input.Default != nil && input.DynamicOptions == nil && !input.AllowCustom && !slices.Contains(input.Options, *input.Default) {
			return bail(file, 0, "inputs."+input.Name+".default", fmt.Sprintf("default '%s' is not in available values", *input.Default))
		}
	}
	return nil
}

func loadFromRaw(name, file, source string, raw Document) (*Definition, error) {
	inputs, err := inputsOf(file, raw)
	if err != nil {
		return nil, err
	}
	workflow := &Definition{
		Name: name, File: file, Version: raw.Version, Title: raw.Title, Description: raw.Description,
		Hidden: raw.Hidden, Steps: raw.Steps, Inputs: inputs, Returns: raw.Returns, OnFailure: raw.OnFailure,
		RepoOwned: source == "repo", NeedsTranscript: NeedsTranscript(raw.Steps, raw.Returns), Children: map[string]*Definition{},
	}
	return workflow, nil
}

type loadScope struct {
	RepoRoot string
	Config   config.Config
	Stack    []string
	Cache    map[string]*Definition
}

func loadChild(name string, scope loadScope) (*Definition, error) {
	if slices.Contains(scope.Stack, name) {
		return nil, &LoadError{fmt.Sprintf("workflow cycle: %s", strings.Join(append(slices.Clone(scope.Stack), name), " → "))}
	}
	if cached := scope.Cache[name]; cached != nil {
		return cached, nil
	}
	resolved, err := ResolveWorkflowFile(name, scope.RepoRoot)
	if errors.Is(err, ErrWorkflowNotFound) {
		return nil, &LoadError{fmt.Sprintf("workflow '%s' not found (via %s)", name, strings.Join(scope.Stack, " → "))}
	}
	if err != nil {
		return nil, err
	}
	body, err := os.ReadFile(resolved.File)
	if err != nil {
		return nil, err
	}
	raw, err := ParseRaw(resolved.File, string(body))
	if err != nil {
		return nil, err
	}
	workflow, err := loadFromRaw(name, resolved.File, resolved.Source, raw)
	if err != nil {
		return nil, err
	}
	loaded, err := finalizeWorkflow(workflow, loadScope{RepoRoot: scope.RepoRoot, Config: scope.Config, Stack: append(slices.Clone(scope.Stack), name), Cache: scope.Cache})
	if err == nil {
		scope.Cache[name] = loaded
	}
	return loaded, err
}

func finalizeWorkflow(workflow *Definition, scope loadScope) (*Definition, error) {
	if err := assertInputsUsed(workflow.File, *workflow); err != nil {
		return nil, err
	}
	if err := finalizeInputs(workflow.File, workflow.Inputs); err != nil {
		return nil, err
	}
	childReturns := map[string]*ReturnsSpec{}
	for _, childName := range workflowChildNames(*workflow) {
		if workflow.Children[childName] != nil {
			continue
		}
		child, err := loadChild(childName, scope)
		if err != nil {
			return nil, err
		}
		workflow.Children[childName] = child
	}
	for _, step := range workflow.Steps {
		if step.ID == "" {
			continue
		}
		if action, ok := step.Action.(WorkflowAction); ok {
			childReturns[step.ID] = workflow.Children[action.Name].Returns
		}
	}
	profiles := map[string]bool{}
	for _, name := range config.ProfileNames(scope.Config) {
		profiles[name] = true
	}
	producers, err := assertWorkflowReferences(workflow.File, *workflow, childReturns, profiles)
	if err != nil {
		return nil, err
	}
	for i, step := range workflow.Steps {
		if action, ok := step.Action.(WorkflowAction); ok {
			if err := assertChildInputContract(workflow.File, i+1, action.Inputs, *workflow.Children[action.Name], producers, workflow.Inputs, profiles, step.When); err != nil {
				return nil, err
			}
		}
	}
	if action, ok := workflow.OnFailure.(WorkflowAction); ok {
		if err := assertChildInputContract(workflow.File, 0, action.Inputs, *workflow.Children[action.Name], producers, workflow.Inputs, profiles, nil); err != nil {
			return nil, err
		}
	}
	return workflow, nil
}

func configFor(repoRoot string, supplied []config.Config) (config.Config, error) {
	if len(supplied) > 0 {
		return supplied[0], nil
	}
	return config.LoadConfig(repoRoot, nil)
}

// ParseWorkflowText parses and validates a workflow body.
// It does not resolve the entry from the filesystem.
func ParseWorkflowText(name, text string, cfg config.Config, repoRoot string, file ...string) (*Definition, error) {
	entryFile := name + ".yaml"
	if len(file) > 0 && file[0] != "" {
		entryFile = file[0]
	}
	raw, err := ParseRaw(entryFile, text)
	if err != nil {
		return nil, err
	}
	workflow, err := loadFromRaw(name, entryFile, "repo", raw)
	if err != nil {
		return nil, err
	}
	return finalizeWorkflow(workflow, loadScope{RepoRoot: repoRoot, Config: cfg, Stack: []string{name}, Cache: map[string]*Definition{}})
}

// LoadWorkflow loads the repository-first workflow by name.
func LoadWorkflow(name, repoRoot string, supplied ...config.Config) (*Definition, error) {
	resolved, err := ResolveWorkflowFile(name, repoRoot)
	if errors.Is(err, ErrWorkflowNotFound) {
		return nil, &LoadError{fmt.Sprintf("workflow '%s' not found", name)}
	}
	if err != nil {
		return nil, err
	}
	return LoadWorkflowEntry(ListEntry{Name: name, Source: resolved.Source, File: resolved.File}, repoRoot, supplied...)
}

// LoadWorkflowEntry loads an explicitly selected source file.
func LoadWorkflowEntry(entry ListEntry, repoRoot string, supplied ...config.Config) (*Definition, error) {
	if _, err := os.Stat(entry.File); err != nil {
		return nil, bail(entry.File, 0, "", "file not found")
	}
	cfg, err := configFor(repoRoot, supplied)
	if err != nil {
		return nil, err
	}
	body, err := os.ReadFile(entry.File)
	if err != nil {
		return nil, err
	}
	raw, err := ParseRaw(entry.File, string(body))
	if err != nil {
		return nil, err
	}
	workflow, err := loadFromRaw(entry.Name, entry.File, entry.Source, raw)
	if err != nil {
		return nil, err
	}
	return finalizeWorkflow(workflow, loadScope{RepoRoot: repoRoot, Config: cfg, Stack: []string{entry.Name}, Cache: map[string]*Definition{}})
}

func yamlWorkflowNames(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var names []string
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".yaml" {
			continue
		}
		name := strings.TrimSuffix(entry.Name(), ".yaml")
		names = append(names, name)
	}
	slices.Sort(names)
	return names
}

// ListWorkflows returns repo-over-global workflow metadata. It does not run dynamic commands.
func ListWorkflows(repoRoot string, supplied ...config.Config) ([]ListEntry, error) {
	cfg, err := configFor(repoRoot, supplied)
	if err != nil {
		return nil, err
	}
	home, err := config.HomeDir(nil)
	if err != nil {
		return nil, err
	}
	globalDir := filepath.Join(home, ".hwf", "workflows")
	entriesByName := map[string]ListEntry{}
	for _, name := range yamlWorkflowNames(globalDir) {
		entriesByName[name] = ListEntry{Name: name, Source: "global", File: filepath.Join(globalDir, name+".yaml")}
	}
	repoDir := filepath.Join(repoRoot, ".hwf", "workflows")
	if repoDir != globalDir {
		for _, name := range yamlWorkflowNames(repoDir) {
			entriesByName[name] = ListEntry{Name: name, Source: "repo", File: filepath.Join(repoDir, name+".yaml"), RepoOwned: true}
		}
	}
	names := make([]string, 0, len(entriesByName))
	for name := range entriesByName {
		names = append(names, name)
	}
	slices.Sort(names)
	result := make([]ListEntry, 0, len(names))
	for _, name := range names {
		entry := entriesByName[name]
		workflow, loadErr := LoadWorkflowEntry(entry, repoRoot, cfg)
		if loadErr != nil {
			entry.Error = loadErr.Error()
			result = append(result, entry)
			continue
		}
		entry.Hidden, entry.Title, entry.Description = workflow.Hidden, workflow.Title, workflow.Description
		entry.Inputs, entry.RepoOwned = workflow.Inputs, workflow.RepoOwned
		entry.DynamicOptions = slices.ContainsFunc(workflow.Inputs, func(input InputSpec) bool { return input.DynamicOptions != nil })
		flags := AnalyzeResolvedSensitivity(Document{
			Steps: workflow.Steps, Returns: workflow.Returns, OnFailure: workflow.OnFailure,
		}, workflow.Name, repoRoot)
		entry.HasCommands, entry.NeedsTranscript = flags.HasCommands, flags.HasTranscript || workflow.NeedsTranscript
		entry.SensitiveMethods, entry.UnresolvedChildren = flags.SensitiveMethods, flags.UnresolvedChildren
		result = append(result, entry)
	}
	return result, nil
}

// CompleteWorkflowInputs runs input collection for the entry or a child.
func CompleteWorkflowInputs(ctx context.Context, workflow *Definition, opts InputSessionOptions, provided map[string]string) (CollectedInputs, error) {
	opts.Specs, opts.File = workflow.Inputs, workflow.File
	return NewInputSession(opts).CompleteFromProvided(ctx, provided)
}
