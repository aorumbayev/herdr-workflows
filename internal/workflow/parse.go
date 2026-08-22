package workflow

import (
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/host"
	"gopkg.in/yaml.v3"
)

// LoadError reports a workflow document that failed to load.
type LoadError struct{ msg string }

func (e *LoadError) Error() string { return e.msg }

func positioned(file string, step int, key, message string) string {
	parts := []string{file}
	if step > 0 {
		parts = append(parts, "step "+strconv.Itoa(step))
	}
	if key != "" {
		parts = append(parts, key)
	}
	return strings.Join(parts, ", ") + ": " + message
}

func bail(file string, step int, key, message string) error {
	return &LoadError{positioned(file, step, key, message)}
}

// issue is one schema-level problem at a workflow location.
type issue struct {
	step int
	key  string
	msg  string
}

type issues struct{ list []issue }

func (i *issues) add(step int, key, msg string) {
	i.list = append(i.list, issue{step: step, key: key, msg: msg})
}

func yamlValueType(v any) string {
	switch v.(type) {
	case nil:
		return "null"
	case string:
		return "string"
	case bool:
		return "boolean"
	case int, int64, float64:
		return "number"
	case []any:
		return "array"
	case map[string]any:
		return "object"
	default:
		return "unknown"
	}
}

func typeMismatch(expected string, v any) string {
	return fmt.Sprintf("Invalid input: expected %s, received %s", expected, yamlValueType(v))
}

var (
	whenEqRE       = regexp.MustCompile(`^\{\{\s*(` + templateInner + `)\s*\}\}\s*(==|!=)\s*(?:"([^"]*)"|'([^']*)')$`)
	verdictTokenRE = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,31}$`)
)

// VerdictTokenPattern is the verdict token shape, for error messages.
const VerdictTokenPattern = "[A-Z][A-Z0-9_]{0,31}"

// ParseDuration parses a positive <integer><ms|s|m|h> duration.
func ParseDuration(text string) (time.Duration, error) {
	m := durationRE.FindStringSubmatch(text)
	if m == nil {
		return 0, &LoadError{fmt.Sprintf("duration must be positive <integer><ms|s|m|h> (got '%s')", text)}
	}
	n, _ := strconv.Atoi(m[1])
	switch m[2] {
	case "ms":
		return time.Duration(n) * time.Millisecond, nil
	case "s":
		return time.Duration(n) * time.Second, nil
	case "m":
		return time.Duration(n) * time.Minute, nil
	}
	return time.Duration(n) * time.Hour, nil
}

// checker collects schema issues while a workflow is loaded.
type checker struct {
	issues issues
}

func (c *checker) add(step int, key, msg string) {
	c.issues.add(step, key, msg)
}

func (c *checker) scope(step int, key string) *validationScope {
	return &validationScope{c: c, step: step, key: key}
}

type validationScope struct {
	c        *checker
	step     int
	key      string
	fullPath bool
}

func joinKey(base string, parts ...any) string {
	for _, part := range parts {
		segment := fmt.Sprint(part)
		if base == "" {
			base = segment
		} else {
			base += "." + segment
		}
	}
	return base
}

func (s *validationScope) sub(rest ...any) *validationScope {
	return &validationScope{c: s.c, step: s.step, key: joinKey(s.key, rest...), fullPath: s.fullPath}
}

func (s *validationScope) add(msg string, rest ...any) {
	if !s.fullPath && len(rest) > 1 {
		rest = rest[:1]
	}
	s.c.add(s.step, joinKey(s.key, rest...), msg)
}

func (s *validationScope) fail(msg string) {
	s.add(msg)
}

func isString(v any) bool {
	_, ok := v.(string)
	return ok
}

// checkString validates a present string field, optionally min-length 1.
func (s *validationScope) checkString(m map[string]any, key string, minLen bool) {
	v, ok := m[key]
	if !ok {
		return
	}
	text, ok := v.(string)
	if !ok {
		s.add(typeMismatch("string", v), key)
		return
	}
	if minLen && text == "" {
		s.add("Too small: expected string to have >=1 characters", key)
	}
}

func (s *validationScope) checkBool(m map[string]any, key string) {
	if v, ok := m[key]; ok && v != nil {
		if _, isBool := v.(bool); !isBool {
			s.add(typeMismatch("boolean", v), key)
		}
	}
}

func (s *validationScope) checkStringMap(m map[string]any, key string) {
	v, ok := m[key]
	if !ok {
		return
	}
	obj, ok := v.(map[string]any)
	if !ok {
		s.add(typeMismatch("object", v), key)
		return
	}
	for _, k := range sortedKeys(obj) {
		if !isString(obj[k]) {
			s.add(typeMismatch("string", obj[k]), key, k)
		}
	}
}

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys
}

func (s *validationScope) checkWhen(m map[string]any, key string) {
	v, ok := m[key]
	if !ok {
		return
	}
	switch w := v.(type) {
	case string:
		if w == "" {
			s.add("Too small: expected string to have >=1 characters", key)
		}
	case []any:
		if len(w) == 0 {
			s.add("Too small: expected array to have >=1 items", key)
			return
		}
		for i, el := range w {
			text, ok := el.(string)
			if !ok {
				s.add(typeMismatch("string", el), key, i)
			} else if text == "" {
				s.add("Too small: expected string to have >=1 characters", key, i)
			}
		}
	default:
		s.add("Invalid input", key)
	}
}

func (s *validationScope) checkRun(m map[string]any) {
	v, ok := m["run"]
	if !ok {
		return
	}
	switch r := v.(type) {
	case string:
		if r == "" {
			s.add("Invalid input", "run")
		}
	case []any:
		if len(r) == 0 {
			s.add("Invalid input", "run")
			return
		}
		for _, el := range r {
			if !isString(el) {
				s.add("Invalid input", "run")
				return
			}
		}
	default:
		s.add("Invalid input", "run")
	}
}

func (s *validationScope) checkDuration(m map[string]any, key string) {
	v, ok := m[key]
	if !ok {
		return
	}
	text, ok := v.(string)
	if !ok {
		s.add(typeMismatch("string", v), key)
		return
	}
	if !durationRE.MatchString(text) {
		s.add("duration must be positive <integer><ms|s|m|h>", key)
	}
}

func (s *validationScope) checkReadyWhen(m map[string]any) {
	v, ok := m["ready_when"]
	if !ok {
		return
	}
	text, ok := v.(string)
	if !ok {
		s.add(typeMismatch("string", v), "ready_when")
		return
	}
	if !strings.HasPrefix(text, "/") || !strings.HasSuffix(text, "/") || len(text) < 3 {
		s.add("ready_when: must be a non-empty /regex/ with no flags", "ready_when")
		return
	}
	if text[1:len(text)-1] == "" {
		s.add("ready_when: regex must be non-empty", "ready_when")
		return
	}
	if _, err := regexp.Compile(text[1 : len(text)-1]); err != nil {
		s.add("ready_when: invalid regex", "ready_when")
	}
}

func (s *validationScope) checkPane(m map[string]any) {
	v, ok := m["pane"]
	if !ok {
		return
	}
	pane, ok := v.(map[string]any)
	if !ok {
		s.add(typeMismatch("object", v), "pane")
		return
	}
	before := len(s.c.issues.list)
	p := s.sub("pane")
	for _, k := range sortedKeys(pane) {
		if !slices.Contains([]string{"open", "target", "workspace", "size", "focus", "name", "close"}, k) {
			p.fail(fmt.Sprintf("Unrecognized key: %q", k))
		}
	}
	openValue, hasOpen := pane["open"]
	if !hasOpen {
		p.add(typeMismatch("string", nil), "open")
	} else if open, ok := openValue.(string); !ok {
		p.add(typeMismatch("string", openValue), "open")
	} else if !slices.Contains(PaneOpens, open) && !IsWholeValueTemplate(open) {
		p.add("pane.open must be tab, beside, below, or a whole-value template", "open")
	}
	p.checkString(pane, "target", true)
	p.checkString(pane, "workspace", true)
	if size, ok := pane["size"]; ok {
		if checkInt(p, size, "size") {
			switch n := asInt(size); {
			case n < 1:
				p.add("Too small: expected number to be >=1", "size")
			case n > 99:
				p.add("Too big: expected number to be <=99", "size")
			}
		}
	}
	p.checkBool(pane, "focus")
	p.checkString(pane, "name", true)
	if close, ok := pane["close"]; ok {
		if text, ok := close.(string); !ok {
			p.add(typeMismatch("string", close), "close")
		} else if text != "success" && text != "always" {
			p.add(`Invalid option: expected one of "success"|"always"`, "close")
		}
	}
	if len(s.c.issues.list) != before {
		return
	}
	// Cross-field placement rules run after the pane fields pass validation.
	open, _ := pane["open"].(string)
	if !slices.Contains(PaneOpens, open) {
		return
	}
	if open == "tab" {
		if _, bad := pane["target"]; bad {
			p.add("pane.target applies only to beside/below", "target")
		}
		if _, bad := pane["size"]; bad {
			p.add("pane.size applies only to beside/below", "size")
		}
		return
	}
	if _, bad := pane["workspace"]; bad {
		p.add("pane.workspace applies only to tab", "workspace")
	}
	if _, bad := pane["name"]; bad {
		p.add("pane.name applies only to tab — a split joins an existing tab", "name")
	}
}

// checkInt validates an integer-valued number and reports whether it passed.
func checkInt(s *validationScope, v any, rest ...any) bool {
	switch n := v.(type) {
	case int:
		_ = n
	case float64:
		if n != float64(int64(n)) {
			s.add("Invalid input: expected int, received number", rest...)
			return false
		}
	default:
		s.add(typeMismatch("number", v), rest...)
		return false
	}
	return true
}

func asInt(v any) int64 {
	switch n := v.(type) {
	case int:
		return int64(n)
	case float64:
		return int64(n)
	}
	return 0
}

func (s *validationScope) checkExpect(m map[string]any) {
	v, ok := m["expect"]
	if !ok {
		return
	}
	expect, ok := v.(map[string]any)
	if !ok {
		s.add(typeMismatch("object", v), "expect")
		return
	}
	before := len(s.c.issues.list)
	e := s.sub("expect")
	for _, k := range sortedKeys(expect) {
		if k != "one_of" && k != "require" {
			e.fail(fmt.Sprintf("Unrecognized key: %q", k))
		}
	}
	checkTokens := func(key string) bool {
		value, ok := expect[key]
		if !ok {
			if key == "one_of" {
				e.add(typeMismatch("array", nil), "one_of")
			}
			return true
		}
		tokens, ok := value.([]any)
		if !ok {
			e.add(typeMismatch("array", value), key)
			return false
		}
		if len(tokens) == 0 {
			e.add("Too small: expected array to have >=1 items", key)
			return false
		}
		okAll := true
		for i, token := range tokens {
			text, ok := token.(string)
			if !ok {
				e.add(typeMismatch("string", token), key, i)
				okAll = false
			} else if !verdictTokenRE.MatchString(text) {
				e.add("verdict token must match "+VerdictTokenPattern, key, i)
				okAll = false
			}
		}
		return okAll
	}
	oneOfOK := checkTokens("one_of")
	_, hasRequire := expect["require"]
	requireOK := !hasRequire
	if hasRequire {
		requireOK = checkTokens("require")
	}
	if len(s.c.issues.list) != before {
		return
	}
	//nolint:nestif // verdict validation combines token shape and subset rules.
	if oneOfOK && requireOK {
		oneOf := tokenStrings(expect["one_of"])
		seen := map[string]bool{}
		for i, token := range oneOf {
			if seen[token] {
				e.add(fmt.Sprintf("expect.one_of: duplicate verdict token '%s'", token), "one_of", i)
			}
			seen[token] = true
		}
		if hasRequire {
			for i, token := range tokenStrings(expect["require"]) {
				if !seen[token] {
					e.add(fmt.Sprintf("expect.require: '%s' is not in one_of", token), "require", i)
				}
			}
		}
	}
}

func tokenStrings(v any) []string {
	var out []string
	for _, el := range v.([]any) {
		out = append(out, el.(string))
	}
	return out
}

func (s *validationScope) checkRetry(m map[string]any) {
	v, ok := m["retry"]
	if !ok {
		return
	}
	retry, ok := v.(map[string]any)
	if !ok {
		s.add(typeMismatch("object", v), "retry")
		return
	}
	r := s.sub("retry")
	for _, k := range sortedKeys(retry) {
		if k != "attempts" && k != "delay" {
			r.fail(fmt.Sprintf("Unrecognized key: %q", k))
		}
	}
	attempts, hasAttempts := retry["attempts"]
	if !hasAttempts {
		r.add(typeMismatch("number", nil), "attempts")
	} else if checkInt(r, attempts, "attempts") && asInt(attempts) < 2 {
		r.add("Too small: expected number to be >=2", "attempts")
	}
	r.checkDuration(retry, "delay")
}

func (s *validationScope) checkSuccessCodes(m map[string]any) {
	v, ok := m["success_codes"]
	if !ok {
		return
	}
	codes, ok := v.([]any)
	if !ok {
		s.add(typeMismatch("array", v), "success_codes")
		return
	}
	if len(codes) == 0 {
		s.add("Too small: expected array to have >=1 items", "success_codes")
		return
	}
	valid := true
	for i, code := range codes {
		if !checkInt(s, code, "success_codes", i) {
			valid = false
		}
	}
	if !valid {
		return
	}
	seen := map[int64]bool{}
	for i, code := range codes {
		n := asInt(code)
		if seen[n] {
			s.add(fmt.Sprintf("success_codes: duplicate exit code %d", n), "success_codes", i)
		}
		seen[n] = true
	}
}

var actionKeys = []string{"agent", "run", "herdr", "workflow"}

var stepAllowedKeys = map[string][]string{
	"agent": {
		"id", "when", "continue_on_error", "using", "target", "cwd", "env", "pane",
		"background", "timeout", "expect",
	},
	"run": {
		"id", "when", "continue_on_error", "shell", "cwd", "env", "pane", "background",
		"ready_when", "timeout", "retry", "success_codes",
	},
	"herdr":    {"id", "when", "continue_on_error", "params", "retry"},
	"workflow": {"id", "when", "continue_on_error", "inputs"},
}

func (s *validationScope) checkUnknownKeys(step map[string]any, action string, allowed []string) {
	for _, key := range sortedKeys(step) {
		if key == action || slices.Contains(allowed, key) {
			continue
		}
		s.fail(fmt.Sprintf("Unrecognized key: %q", key))
	}
}

func (s *validationScope) refineAgentCore(step map[string]any) {
	if prompt, ok := step["agent"]; !ok || prompt == "" {
		s.add("agent: prompt text is required", "agent")
	}
	_, hasUsing := step["using"]
	_, hasTarget := step["target"]
	if hasUsing && hasTarget {
		s.add("using: and target: are mutually exclusive", "using")
	}
}

func (s *validationScope) refineAgentStep(step map[string]any) {
	s.checkUnknownKeys(step, "agent", stepAllowedKeys["agent"])
	s.refineAgentCore(step)
	if _, hasTarget := step["target"]; hasTarget {
		for _, key := range []string{"pane", "cwd", "env"} {
			if _, bad := step[key]; bad {
				s.add("target: rejects "+key+":", key)
			}
		}
	}
	//nolint:nestif // background constraints are action-specific schema rules.
	if step["background"] == true {
		if _, bad := step["timeout"]; bad {
			s.add("background: rejects timeout", "timeout")
		}
		if _, bad := step["expect"]; bad {
			s.add("background: rejects expect — a background turn produces no result", "expect")
		}
		if pane, ok := step["pane"].(map[string]any); ok {
			if _, bad := pane["close"]; bad {
				s.add("background: rejects pane.close", "pane", "close")
			}
		}
	}
}

func (s *validationScope) refineRunPayload(step map[string]any) {
	run, hasRun := step["run"]
	argv, isArgv := run.([]any)
	command, isShell := run.(string)
	switch {
	case hasRun && !isArgv && !isShell:
		s.add("run: must be a non-empty string or string list", "run")
	case isShell && command == "":
		s.add("run: must be non-empty", "run")
	}
	if isArgv {
		if len(argv) == 0 {
			s.add("run: argv must be non-empty", "run")
		}
		if _, hasShell := step["shell"]; hasShell {
			s.add("argv form does not use a shell", "shell")
		}
	}
	if isShell && anyMustacheRE.MatchString(command) {
		s.add("templates are not allowed in shell command text — use argv form or explicit env values", "run")
	}
	if shell, ok := step["shell"]; ok {
		if text, isString := shell.(string); isString && !slices.Contains(Shells, text) {
			s.add("shell: must be one of "+strings.Join(Shells, ", "), "shell")
		}
	}
}

func (s *validationScope) refineRunLifecycle(step map[string]any) {
	pane, hasPane := step["pane"]
	_, hasReadyWhen := step["ready_when"]
	if step["background"] == true {
		if hasReadyWhen {
			s.add("background: and ready_when: are mutually exclusive", "ready_when")
		}
		if _, bad := step["timeout"]; bad {
			s.add("background: rejects timeout", "timeout")
		}
		if _, bad := step["retry"]; bad {
			s.add("background: rejects retry", "retry")
		}
	}
	//nolint:nestif // placement constraints combine pane and readiness fields.
	if hasPane {
		if step["background"] != true && !hasReadyWhen {
			s.add("placed run requires background: or ready_when:", "pane")
		}
		if obj, ok := pane.(map[string]any); ok {
			if _, bad := obj["close"]; bad {
				s.add("run: rejects pane.close", "pane", "close")
			}
		}
	}
	if hasReadyWhen {
		if !hasPane {
			s.add("ready_when: requires pane:", "ready_when")
		}
		if _, bad := step["timeout"]; !bad {
			s.add("ready_when: requires timeout", "timeout")
		}
		if _, bad := step["retry"]; bad {
			s.add("ready_when: rejects retry", "retry")
		}
	}
	if step["background"] == true && !hasPane {
		s.add("background: requires pane:", "background")
	}
	if _, hasCodes := step["success_codes"]; hasCodes {
		if hasPane || step["background"] == true || hasReadyWhen {
			s.add("success_codes: applies only to blocking local run:", "success_codes")
		}
	}
}

func (s *validationScope) refineRunStep(step map[string]any) {
	s.checkUnknownKeys(step, "run", stepAllowedKeys["run"])
	s.refineRunPayload(step)
	s.refineRunLifecycle(step)
}

func (s *validationScope) refineHerdrStep(step map[string]any) {
	s.checkUnknownKeys(step, "herdr", stepAllowedKeys["herdr"])
	if method, ok := step["herdr"]; !ok || method == "" {
		s.add("herdr: method is required", "herdr")
	}
}

func (s *validationScope) refineWorkflowStep(step map[string]any) {
	s.checkUnknownKeys(step, "workflow", stepAllowedKeys["workflow"])
	if name, ok := step["workflow"]; !ok || name == "" {
		s.add("workflow: name is required", "workflow")
	}
}

// checkStepShape validates fields that have a fixed shape before refinements.
func (s *validationScope) checkStepShape(step map[string]any) bool {
	before := len(s.c.issues.list)
	shape := &validationScope{c: s.c, step: s.step, key: s.key}
	if id, ok := step["id"]; ok {
		text, isString := id.(string)
		if !isString {
			shape.add(typeMismatch("string", id), "id")
		} else if !identRE.MatchString(text) {
			shape.add("must match [a-z][a-z0-9_]{0,31}", "id")
		}
	}
	shape.checkWhen(step, "when")
	shape.checkBool(step, "continue_on_error")
	shape.checkString(step, "agent", false)
	shape.checkString(step, "using", true)
	shape.checkString(step, "target", true)
	shape.checkRun(step)
	if shell, ok := step["shell"]; ok {
		if text, isString := shell.(string); !isString {
			shape.add(typeMismatch("string", shell), "shell")
		} else if !slices.Contains(Shells, text) {
			shape.add(`Invalid option: expected one of "sh"|"bash"|"zsh"|"pwsh"|"powershell"|"cmd"`, "shell")
		}
	}
	shape.checkString(step, "herdr", false)
	if params, ok := step["params"]; ok {
		if _, isObj := params.(map[string]any); !isObj {
			shape.add(typeMismatch("object", params), "params")
		}
	}
	shape.checkString(step, "workflow", false)
	shape.checkStringMap(step, "inputs")
	shape.checkString(step, "cwd", true)
	shape.checkStringMap(step, "env")
	shape.checkPane(step)
	shape.checkReadyWhen(step)
	shape.checkDuration(step, "timeout")
	shape.checkExpect(step)
	shape.checkSuccessCodes(step)
	shape.checkBool(step, "background")
	shape.checkRetry(step)
	return len(s.c.issues.list) == before
}

func (s *validationScope) checkRecoveryShape(step map[string]any) bool {
	before := len(s.c.issues.list)
	shape := &validationScope{c: s.c, step: s.step, key: s.key}
	shape.checkString(step, "agent", false)
	shape.checkString(step, "using", true)
	shape.checkString(step, "target", true)
	shape.checkRun(step)
	if shell, ok := step["shell"]; ok {
		if text, isString := shell.(string); !isString {
			shape.add(typeMismatch("string", shell), "shell")
		} else if !slices.Contains(Shells, text) {
			shape.add(`Invalid option: expected one of "sh"|"bash"|"zsh"|"pwsh"|"powershell"|"cmd"`, "shell")
		}
	}
	shape.checkString(step, "herdr", false)
	if params, ok := step["params"]; ok {
		if _, isObj := params.(map[string]any); !isObj {
			shape.add(typeMismatch("object", params), "params")
		}
	}
	shape.checkString(step, "workflow", false)
	shape.checkStringMap(step, "inputs")
	shape.checkString(step, "cwd", true)
	shape.checkStringMap(step, "env")
	shape.checkPane(step)
	shape.checkReadyWhen(step)
	shape.checkDuration(step, "timeout")
	shape.checkExpect(step)
	shape.checkSuccessCodes(step)
	return len(s.c.issues.list) == before
}

func (c *checker) checkStep(index int, value any) {
	s := c.scope(index+1, "")
	step, ok := value.(map[string]any)
	if !ok {
		s.fail(typeMismatch("object", value))
		return
	}
	if !s.checkStepShape(step) {
		return
	}
	refine := c.scope(index+1, "")
	var actions []string
	for _, key := range actionKeys {
		if _, ok := step[key]; ok {
			actions = append(actions, key)
		}
	}
	switch len(actions) {
	case 0:
		refine.fail("step has no action key (expected agent, run, herdr, or workflow)")
	case 1:
	default:
		refine.fail("step has multiple action keys: " + strings.Join(actions, ", "))
		return
	}
	if len(actions) != 1 {
		return
	}
	switch actions[0] {
	case "agent":
		refine.refineAgentStep(step)
	case "run":
		refine.refineRunStep(step)
	case "herdr":
		refine.refineHerdrStep(step)
	case "workflow":
		refine.refineWorkflowStep(step)
	}
}

var recoveryRejected = []string{"id", "when", "continue_on_error", "background", "retry"}

var recoveryAllowedKeys = map[string][]string{
	"agent":    {"using", "target", "cwd", "env", "pane", "timeout", "expect"},
	"run":      {"shell", "cwd", "env", "pane", "ready_when", "timeout"},
	"herdr":    {"params"},
	"workflow": {"inputs"},
}

func (c *checker) checkRecovery(value any) {
	s := c.scope(0, "on_failure")
	step, ok := value.(map[string]any)
	if !ok {
		s.fail(typeMismatch("object", value))
		return
	}
	if !s.checkRecoveryShape(step) {
		return
	}
	refine := c.scope(0, "on_failure")
	for _, key := range recoveryRejected {
		if _, bad := step[key]; bad {
			refine.add("on_failure rejects "+key+":", key)
		}
	}
	var actions []string
	for _, key := range actionKeys {
		if _, ok := step[key]; ok {
			actions = append(actions, key)
		}
	}
	if len(actions) != 1 {
		if len(actions) == 0 {
			refine.fail("step has no action key (expected agent, run, herdr, or workflow)")
		} else {
			refine.fail("step has multiple action keys: " + strings.Join(actions, ", "))
		}
		return
	}
	action := actions[0]
	refine.checkUnknownKeys(step, action, recoveryAllowedKeys[action])
	switch action {
	case "agent":
		refine.refineAgentCore(step)
	case "run":
		scrubbed := deleteKeys(step, recoveryRejected...)
		refine.refineRunPayload(scrubbed)
		refine.refineRunLifecycle(scrubbed)
	case "herdr":
		if method, ok := step["herdr"]; !ok || method == "" {
			refine.add("herdr: method is required", "herdr")
		}
	case "workflow":
		if name, ok := step["workflow"]; !ok || name == "" {
			refine.add("workflow: name is required", "workflow")
		}
	}
}

func deleteKeys(m map[string]any, keys ...string) map[string]any {
	out := maps.Clone(m)
	for _, key := range keys {
		delete(out, key)
	}
	return out
}

func (c *checker) checkInput(name string, value any) {
	s := &validationScope{c: c, key: joinKey("inputs", name), fullPath: true}
	switch v := value.(type) {
	case string:
		if v != "text" && v != "profile" {
			s.fail("Invalid input")
		}
	case []any:
		if len(v) == 0 {
			s.fail("Too small: expected array to have >=1 items")
			return
		}
		for i, el := range v {
			text, ok := el.(string)
			if !ok {
				s.add(typeMismatch("string", el), i)
			} else if text == "" {
				s.add("Too small: expected string to have >=1 characters", i)
			}
		}
	case map[string]any:
		before := len(c.issues.list)
		for _, k := range sortedKeys(v) {
			if !slices.Contains([]string{
				"type", "description", "default", "options", "when",
				"allow_custom", "min_length",
			}, k) {
				s.fail(fmt.Sprintf("Unrecognized key: %q", k))
			}
		}
		if typ, ok := v["type"]; ok {
			if text, isString := typ.(string); !isString {
				s.add(typeMismatch("string", typ), "type")
			} else if !slices.Contains([]string{"text", "choice", "profile"}, text) {
				s.add(`Invalid option: expected one of "text"|"choice"|"profile"`, "type")
			}
		}
		s.checkString(v, "description", false)
		s.checkString(v, "default", false)
		s.checkInputOptions(v)
		s.checkWhen(v, "when")
		s.checkBool(v, "allow_custom")
		if min, ok := v["min_length"]; ok {
			if checkInt(s, min, "min_length") && asInt(min) < 0 {
				s.add("Too small: expected number to be >=0", "min_length")
			}
		}
		if len(c.issues.list) != before {
			return
		}
		typ, _ := v["type"].(string)
		if typ == "" {
			if _, hasOptions := v["options"]; hasOptions {
				typ = "choice"
			} else {
				typ = "text"
			}
		}
		_, hasOptions := v["options"]
		if typ == "choice" && !hasOptions {
			s.add("choice input requires options", "options")
		}
		if (typ == "text" || typ == "profile") && hasOptions {
			s.add(typ+" input rejects options", "options")
		}
		if _, hasCustom := v["allow_custom"]; hasCustom && typ != "choice" {
			s.add("allow_custom is only valid on choice inputs", "allow_custom")
		}
	default:
		s.fail("Invalid input")
	}
}

func (s *validationScope) checkInputOptions(m map[string]any) {
	v, ok := m["options"]
	if !ok {
		return
	}
	switch options := v.(type) {
	case []any:
		if len(options) == 0 {
			s.add("Invalid input", "options")
			return
		}
		for _, el := range options {
			if text, isString := el.(string); !isString || text == "" {
				s.add("Invalid input", "options")
				return
			}
		}
	case map[string]any:
		before := len(s.c.issues.list)
		d := s.sub("options")
		for _, k := range sortedKeys(options) {
			if k != "run" {
				d.fail(fmt.Sprintf("Unrecognized key: %q", k))
			}
		}
		run, hasRun := options["run"]
		//nolint:nestif // dynamic choice validation has one nested schema shape.
		if !hasRun {
			d.add(typeMismatch("array", nil), "run")
		} else if argv, isList := run.([]any); !isList {
			d.add(typeMismatch("array", run), "run")
		} else if len(argv) == 0 {
			d.add("Too small: expected array to have >=1 items", "run")
		} else {
			for i, el := range argv {
				if text, isString := el.(string); !isString {
					d.add(typeMismatch("string", el), "run", i)
				} else if text == "" {
					d.add("Too small: expected string to have >=1 characters", "run", i)
				}
			}
		}
		if len(s.c.issues.list) != before {
			return
		}
		for i, el := range options["run"].([]any) {
			element := el.(string)
			if bad, found := malformedTemplateSnippet(element); found {
				d.add(fmt.Sprintf("invalid template '%s' — expected {{inputs.<earlier input>}}", bad), "run", i)
				continue
			}
			for _, path := range TextTemplates(element) {
				if path.Root != "inputs" || len(path.Segments) != 1 {
					d.add(DynamicArgvRootRule, "run", i)
				}
			}
		}
	default:
		s.add("Invalid input", "options")
	}
}

var topLevelKeys = []string{
	"version", "title", "description", "hidden", "inputs", "returns",
	"on_failure", "steps",
}

func (c *checker) checkReturns(value any) {
	s := c.scope(0, "returns")
	switch v := value.(type) {
	case string:
		if v == "" {
			s.fail("Too small: expected string to have >=1 characters")
		}
	case map[string]any:
		if len(v) == 0 {
			s.fail("returns: map must be non-empty")
			return
		}
		for _, k := range sortedKeys(v) {
			if !identRE.MatchString(k) {
				s.fail("Invalid key in record")
				continue
			}
			text, ok := v[k].(string)
			if !ok {
				s.add(typeMismatch("string", v[k]), k)
			} else if text == "" {
				s.add("Too small: expected string to have >=1 characters", k)
			}
		}
	default:
		s.fail("Invalid input")
	}
}

func (c *checker) checkDoc(doc map[string]any) {
	var unknown []string
	for _, k := range sortedKeys(doc) {
		if !slices.Contains(topLevelKeys, k) {
			unknown = append(unknown, k)
		}
	}
	if len(unknown) > 0 {
		messages := make([]string, len(unknown))
		for i, k := range unknown {
			messages[i] = fmt.Sprintf("Unrecognized key: %q", k)
		}
		c.add(0, unknown[0], strings.Join(messages, "; "))
	}
	s := c.scope(0, "")
	if v, ok := doc["version"]; ok {
		text, isString := v.(string)
		if !isString {
			s.add(typeMismatch("string", v), "version")
		} else if text != Format {
			s.add(fmt.Sprintf("unsupported workflow format '%s' — supported format is %s; rewrite the workflow or upgrade herdr-workflows", text, Format), "version")
		}
	}
	s.checkString(doc, "title", false)
	s.checkString(doc, "description", false)
	s.checkBool(doc, "hidden")
	//nolint:nestif // input declarations are a nested YAML record.
	if v, ok := doc["inputs"]; ok {
		inputs, isObj := v.(map[string]any)
		if !isObj {
			s.add(typeMismatch("object", v), "inputs")
		} else {
			for _, name := range sortedKeys(inputs) {
				if !identRE.MatchString(name) {
					c.add(0, joinKey("inputs", name), "Invalid key in record")
					continue
				}
				c.checkInput(name, inputs[name])
			}
		}
	}
	if v, ok := doc["returns"]; ok {
		c.checkReturns(v)
	}
	if v, ok := doc["on_failure"]; ok {
		c.checkRecovery(v)
	}
	if v, ok := doc["steps"]; ok {
		steps, isList := v.([]any)
		if !isList {
			s.add(typeMismatch("array", v), "steps")
		} else if len(steps) == 0 {
			s.add("Too small: expected array to have >=1 items", "steps")
		} else {
			for i, step := range steps {
				c.checkStep(i, step)
			}
		}
	}
}

func orderedMappingKeys(text, field string) []string {
	var root yaml.Node
	if err := yaml.Unmarshal([]byte(text), &root); err != nil || len(root.Content) == 0 {
		return nil
	}
	doc := root.Content[0]
	if doc.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(doc.Content); i += 2 {
		if doc.Content[i].Value != field || doc.Content[i+1].Kind != yaml.MappingNode {
			continue
		}
		seen := map[string]bool{}
		var keys []string
		mapping := doc.Content[i+1]
		for j := 0; j+1 < len(mapping.Content); j += 2 {
			key := mapping.Content[j].Value
			if !seen[key] {
				keys = append(keys, key)
				seen[key] = true
			}
		}
		return keys
	}
	return nil
}

func stringValue(m map[string]any, key string) string {
	value, _ := m[key].(string)
	return value
}

func boolValue(m map[string]any, key string) bool {
	value, _ := m[key].(bool)
	return value
}

func parseStringList(value any) []string {
	values, _ := value.([]any)
	result := make([]string, 0, len(values))
	for _, item := range values {
		result = append(result, item.(string))
	}
	return result
}

func checkedStringList(value any) ([]string, error) {
	values, ok := value.([]any)
	if !ok {
		return nil, fmt.Errorf("%s", typeMismatch("array", value))
	}
	result := make([]string, 0, len(values))
	for _, item := range values {
		text, ok := item.(string)
		if !ok {
			return nil, fmt.Errorf("%s", typeMismatch("string", item))
		}
		result = append(result, text)
	}
	return result, nil
}

func checkedInt(value any) (int, error) {
	if number, ok := value.(int); ok {
		return number, nil
	}
	if number, ok := value.(float64); ok && number == float64(int64(number)) {
		return int(number), nil
	}
	return 0, fmt.Errorf("%s", typeMismatch("number", value))
}

func parseStringMap(value any) map[string]string {
	values, _ := value.(map[string]any)
	result := make(map[string]string, len(values))
	for key, item := range values {
		result[key] = item.(string)
	}
	return result
}

func parseRawInputValue(value any) (RawInputValue, error) {
	switch input := value.(type) {
	case string:
		return RawInputShorthand(input), nil
	case []any:
		static, err := checkedStringList(input)
		if err != nil {
			return nil, err
		}
		return RawInputStatic(static), nil
	case map[string]any:
		declaration := &RawInputMap{}
		if value, ok := input["type"]; ok {
			text, ok := value.(string)
			if !ok {
				return nil, fmt.Errorf("%s", typeMismatch("string", value))
			}
			declaration.Type = text
		}
		if value, ok := input["description"]; ok {
			text, ok := value.(string)
			if !ok {
				return nil, fmt.Errorf("%s", typeMismatch("string", value))
			}
			declaration.Description = &text
		}
		if value, ok := input["default"]; ok {
			text, ok := value.(string)
			if !ok {
				return nil, fmt.Errorf("%s", typeMismatch("string", value))
			}
			declaration.Default = &text
		}
		if value, ok := input["options"]; ok {
			options := &RawInputOptions{}
			switch option := value.(type) {
			case []any:
				static, err := checkedStringList(option)
				if err != nil {
					return nil, err
				}
				options.Static = static
			case map[string]any:
				run, err := checkedStringList(option["run"])
				if err != nil {
					return nil, err
				}
				options.Dynamic = &DynamicChoice{Run: run}
			default:
				return nil, fmt.Errorf("%s", typeMismatch("array|object", value))
			}
			declaration.Options = options
		}
		if value, ok := input["when"]; ok {
			switch when := value.(type) {
			case string:
				declaration.When = []string{when}
			case []any:
				parsed, err := checkedStringList(when)
				if err != nil {
					return nil, err
				}
				declaration.When = parsed
				declaration.WhenList = true
			default:
				return nil, fmt.Errorf("%s", typeMismatch("string|array", value))
			}
		}
		if value, ok := input["allow_custom"]; ok {
			custom, ok := value.(bool)
			if !ok {
				return nil, fmt.Errorf("%s", typeMismatch("boolean", value))
			}
			declaration.AllowCustom = &custom
		}
		if value, ok := input["min_length"]; ok {
			minimum, err := checkedInt(value)
			if err != nil {
				return nil, err
			}
			converted := minimum
			declaration.MinLength = &converted
		}
		return declaration, nil
	}
	return nil, fmt.Errorf("%s", typeMismatch("string|array|object", value))
}

func assertValidTemplates(file string, step int, key, text string) error {
	if bad, ok := malformedTemplateSnippet(text); ok {
		return bail(file, step, key,
			fmt.Sprintf("invalid template '%s' — expected {{inputs|steps|context.<path>}}", bad))
	}
	return nil
}

func assertTemplatesInValue(file string, step int, key string, value any) error {
	var found error
	WalkValueStrings(value, key, func(text, path string) any {
		if found == nil {
			found = assertValidTemplates(file, step, path, text)
		}
		return text
	})
	return found
}

// ParseWhenClause parses a single `when:` clause.
func ParseWhenClause(file string, step int, key, value string) (WhenSpec, error) {
	if anyMustacheRE.MatchString(value) {
		if err := assertValidTemplates(file, step, key, value); err != nil {
			return WhenSpec{}, err
		}
	}
	if match := whenEqRE.FindStringSubmatch(value); match != nil {
		comparison := match[3]
		if comparison == "" {
			comparison = match[4]
		}
		return WhenSpec{Kind: WhenEqual, Path: match[1], Value: comparison, Negate: match[2] == "!="}, nil
	}
	if template, ok := parseWholeValueTemplate(value); ok {
		return WhenSpec{Kind: WhenTruthy, Path: template.Root + "." + strings.Join(template.Segments, ".")}, nil
	}
	return WhenSpec{}, bail(file, step, key,
		"when: must be a whole-value template or '{{path}} == \"value\"' / '!=' comparison")
}

func parseWhenClauses(file string, step int, key string, value any) ([]WhenSpec, error) {
	if text, ok := value.(string); ok {
		clause, err := ParseWhenClause(file, step, key, text)
		if err != nil {
			return nil, err
		}
		return []WhenSpec{clause}, nil
	}
	values := value.([]any)
	clauses := make([]WhenSpec, 0, len(values))
	for i, item := range values {
		keyName := fmt.Sprintf("%s[%d]", key, i)
		clause, err := ParseWhenClause(file, step, keyName, item.(string))
		if err != nil {
			return nil, err
		}
		clauses = append(clauses, clause)
	}
	return clauses, nil
}

func parseRetry(value map[string]any) (*RetrySpec, error) {
	delay := time.Duration(0)
	if text, ok := value["delay"].(string); ok {
		parsed, err := ParseDuration(text)
		if err != nil {
			return nil, err
		}
		delay = parsed
	}
	return &RetrySpec{Attempts: int(asInt(value["attempts"])), Delay: delay}, nil
}

func parsePane(value map[string]any) *PaneSpec {
	pane := &PaneSpec{Open: stringValue(value, "open")}
	if target, ok := value["target"]; ok {
		pane.Anchor = target.(string)
	}
	if workspace, ok := value["workspace"]; ok {
		pane.Workspace = workspace.(string)
	}
	if size, ok := value["size"]; ok {
		parsed := int(asInt(size))
		pane.Size = &parsed
	}
	if focus, ok := value["focus"]; ok {
		parsed := focus.(bool)
		pane.Focus = &parsed
	}
	if name, ok := value["name"]; ok {
		pane.Name = name.(string)
	}
	if close, ok := value["close"]; ok {
		pane.Close = close.(string)
	}
	return pane
}

func parseExpect(value map[string]any) *ExpectSpec {
	expect := &ExpectSpec{OneOf: parseStringList(value["one_of"])}
	if require, ok := value["require"]; ok {
		expect.Require = parseStringList(require)
	}
	return expect
}

func parseRunPayload(value any, shell string) RunPayload {
	if command, ok := value.(string); ok {
		return RunPayload{Command: command, Shell: shell}
	}
	return RunPayload{Argv: parseStringList(value.([]any))}
}

func optionalDuration(value map[string]any, key string) (time.Duration, error) {
	text, ok := value[key]
	if !ok {
		return 0, nil
	}
	return ParseDuration(text.(string))
}

func assertActionTemplates(file string, step int, raw map[string]any, keyPrefix string) error {
	key := func(name string) string {
		if keyPrefix == "" {
			return name
		}
		return keyPrefix + "." + name
	}
	//nolint:nestif // each action field has a precise template error path.
	if prompt, ok := raw["agent"].(string); ok {
		if err := assertValidTemplates(file, step, key("agent"), prompt); err != nil {
			return err
		}
		for _, name := range []string{"using", "target"} {
			if value, ok := raw[name].(string); ok {
				if err := assertValidTemplates(file, step, key(name), value); err != nil {
					return err
				}
			}
		}
	}
	if argv, ok := raw["run"].([]any); ok {
		for i, element := range argv {
			if err := assertValidTemplates(file, step, key(fmt.Sprintf("run[%d]", i)), element.(string)); err != nil {
				return err
			}
		}
	}
	if cwd, ok := raw["cwd"].(string); ok {
		if err := assertValidTemplates(file, step, key("cwd"), cwd); err != nil {
			return err
		}
	}
	if env, ok := raw["env"].(map[string]any); ok {
		if err := assertTemplatesInValue(file, step, key("env"), env); err != nil {
			return err
		}
	}
	//nolint:nestif // pane placement has several independently templated fields.
	if pane, ok := raw["pane"].(map[string]any); ok {
		for _, name := range []string{"target", "workspace"} {
			if value, ok := pane[name].(string); ok {
				if err := assertValidTemplates(file, step, key("pane."+name), value); err != nil {
					return err
				}
			}
		}
		if open, ok := pane["open"].(string); ok && strings.Contains(open, "{{") {
			if err := assertValidTemplates(file, step, key("pane.open"), open); err != nil {
				return err
			}
		}
	}
	if params, ok := raw["params"].(map[string]any); ok {
		if err := assertTemplatesInValue(file, step, key("params"), params); err != nil {
			return err
		}
	}
	if inputs, ok := raw["inputs"].(map[string]any); ok {
		if err := assertTemplatesInValue(file, step, key("inputs"), inputs); err != nil {
			return err
		}
	}
	return nil
}

func toAction(file string, step int, raw map[string]any, keyPrefix string) (Action, error) {
	if err := assertActionTemplates(file, step, raw, keyPrefix); err != nil {
		return nil, err
	}
	//nolint:nestif // action conversion follows the four explicit YAML forms.
	if prompt, ok := raw["agent"].(string); ok {
		action := AgentAction{Prompt: prompt}
		action.Using = stringValue(raw, "using")
		action.Target = stringValue(raw, "target")
		action.Cwd = stringValue(raw, "cwd")
		if env, ok := raw["env"]; ok {
			action.Env = parseStringMap(env)
		}
		if pane, ok := raw["pane"].(map[string]any); ok {
			action.Pane = parsePane(pane)
		}
		action.Background = boolValue(raw, "background")
		if timeout, err := optionalDuration(raw, "timeout"); err != nil {
			return nil, err
		} else {
			action.Timeout = timeout
		}
		if expect, ok := raw["expect"].(map[string]any); ok {
			action.Expect = parseExpect(expect)
		}
		return action, nil
	}
	//nolint:nestif // run conversion applies optional lifecycle fields in order.
	if run, ok := raw["run"]; ok {
		action := RunAction{Payload: parseRunPayload(run, stringValue(raw, "shell"))}
		action.Cwd = stringValue(raw, "cwd")
		if env, ok := raw["env"]; ok {
			action.Env = parseStringMap(env)
		}
		if pane, ok := raw["pane"].(map[string]any); ok {
			action.Pane = parsePane(pane)
		}
		action.Background = boolValue(raw, "background")
		if ready, ok := raw["ready_when"].(string); ok {
			action.ReadyWhen = ready[1 : len(ready)-1]
		}
		if timeout, err := optionalDuration(raw, "timeout"); err != nil {
			return nil, err
		} else {
			action.Timeout = timeout
		}
		if retry, ok := raw["retry"].(map[string]any); ok {
			parsed, err := parseRetry(retry)
			if err != nil {
				return nil, err
			}
			action.Retry = parsed
		}
		if codes, ok := raw["success_codes"].([]any); ok {
			action.SuccessCodes = make([]int, 0, len(codes))
			for _, code := range codes {
				action.SuccessCodes = append(action.SuccessCodes, int(asInt(code)))
			}
		}
		return action, nil
	}
	//nolint:nestif // herdr conversion includes load-time invocation validation.
	if method, ok := raw["herdr"].(string); ok {
		params, _ := raw["params"].(map[string]any)
		if err := host.ValidateHerdrInvocation(method, params, IsWholeValueTemplate); err != nil {
			key := "herdr"
			if keyPrefix != "" {
				key = keyPrefix + ".herdr"
			}
			return nil, bail(file, step, key, err.Error())
		}
		action := HerdrAction{Method: method, Params: params}
		if retry, ok := raw["retry"].(map[string]any); ok {
			parsed, err := parseRetry(retry)
			if err != nil {
				return nil, err
			}
			action.Retry = parsed
		}
		return action, nil
	}
	if name, ok := raw["workflow"].(string); ok {
		action := WorkflowAction{Name: name}
		if inputs, ok := raw["inputs"]; ok {
			action.Inputs = parseStringMap(inputs)
		}
		return action, nil
	}
	return nil, bail(file, step, keyPrefix, "step has no action key")
}

func toStep(file string, index int, value any) (Step, error) {
	raw, ok := value.(map[string]any)
	if !ok {
		return Step{}, bail(file, index, "", typeMismatch("object", value))
	}
	step := Step{ID: stringValue(raw, "id"), ContinueOnError: boolValue(raw, "continue_on_error")}
	if value, ok := raw["when"]; ok {
		when, err := parseWhenClauses(file, index, "when", value)
		if err != nil {
			return Step{}, err
		}
		step.When = when
	}
	action, err := toAction(file, index, raw, "")
	if err != nil {
		return Step{}, err
	}
	step.Action = action
	return step, nil
}

func toRecovery(file string, raw map[string]any) (Action, error) {
	return toAction(file, 0, raw, "on_failure")
}

func parseReturns(file string, value any, order []string) (*ReturnsSpec, error) {
	if template, ok := value.(string); ok {
		if err := assertValidTemplates(file, 0, "returns", template); err != nil {
			return nil, err
		}
		if !IsWholeValueTemplate(template) {
			return nil, bail(file, 0, "returns", "returns: must be a whole-value template")
		}
		return &ReturnsSpec{Template: template}, nil
	}
	fields, _ := value.(map[string]any)
	keys := orderedKeysOrSorted(fields, order)
	result := &ReturnsSpec{Fields: make([]NamedTemplate, 0, len(keys))}
	for _, name := range keys {
		template := fields[name].(string)
		if err := assertValidTemplates(file, 0, "returns."+name, template); err != nil {
			return nil, err
		}
		if !IsWholeValueTemplate(template) {
			return nil, bail(file, 0, "returns."+name, "returns: must be a whole-value template")
		}
		result.Fields = append(result.Fields, NamedTemplate{Name: name, Template: template})
	}
	return result, nil
}

func orderedKeysOrSorted(values map[string]any, ordered []string) []string {
	seen := map[string]bool{}
	keys := make([]string, 0, len(values))
	for _, key := range ordered {
		if _, ok := values[key]; ok && !seen[key] {
			keys = append(keys, key)
			seen[key] = true
		}
	}
	for _, key := range sortedKeys(values) {
		if !seen[key] {
			keys = append(keys, key)
		}
	}
	return keys
}

// ParseRaw parses and converts one v1alpha1 workflow document.
func ParseRaw(file, text string) (Document, error) {
	var data any
	if err := yaml.Unmarshal([]byte(text), &data); err != nil {
		return Document{}, bail(file, 0, "", err.Error())
	}
	doc, ok := data.(map[string]any)
	if !ok || doc == nil {
		return Document{}, bail(file, 0, "", "workflow document must be a mapping")
	}
	if _, ok := doc["version"]; !ok {
		return Document{}, bail(file, 0, "version", "version is required — supported format is "+Format)
	}
	if _, ok := doc["steps"]; !ok {
		return Document{}, bail(file, 0, "steps", "steps is required")
	}

	checker := &checker{}
	checker.checkDoc(doc)
	if len(checker.issues.list) > 0 {
		messages := make([]string, len(checker.issues.list))
		for i, iss := range checker.issues.list {
			messages[i] = positioned(file, iss.step, iss.key, iss.msg)
		}
		return Document{}, &LoadError{strings.Join(messages, "; ")}
	}

	raw := Document{
		Version:     Format,
		Title:       stringValue(doc, "title"),
		Description: stringValue(doc, "description"),
		Hidden:      boolValue(doc, "hidden"),
	}
	if inputs, ok := doc["inputs"].(map[string]any); ok {
		order := orderedMappingKeys(text, "inputs")
		for _, name := range orderedKeysOrSorted(inputs, order) {
			value, err := parseRawInputValue(inputs[name])
			if err != nil {
				return Document{}, bail(file, 0, "inputs."+name, err.Error())
			}
			raw.Inputs = append(raw.Inputs, NamedInput{Name: name, Value: value})
		}
	}
	if returns, ok := doc["returns"]; ok {
		parsed, err := parseReturns(file, returns, orderedMappingKeys(text, "returns"))
		if err != nil {
			return Document{}, err
		}
		raw.Returns = parsed
	}
	if recovery, ok := doc["on_failure"].(map[string]any); ok {
		parsed, err := toRecovery(file, recovery)
		if err != nil {
			return Document{}, err
		}
		raw.OnFailure = parsed
	}
	steps := doc["steps"].([]any)
	raw.Steps = make([]Step, 0, len(steps))
	for i, value := range steps {
		parsed, err := toStep(file, i+1, value)
		if err != nil {
			return Document{}, err
		}
		raw.Steps = append(raw.Steps, parsed)
	}
	return raw, nil
}

// DocIssue is one structured validation problem for structured document validation.
type DocIssue struct {
	Path    []any  `json:"path"`
	Message string `json:"message"`
}

func docIssuePath(step int, key string) []any {
	if step > 0 {
		path := []any{"steps", step - 1}
		if key != "" {
			for _, part := range strings.Split(key, ".") {
				path = append(path, part)
			}
		}
		return path
	}
	if key == "" {
		return nil
	}
	path := make([]any, 0, strings.Count(key, ".")+1)
	for _, part := range strings.Split(key, ".") {
		path = append(path, part)
	}
	return path
}

// ValidateDocMap runs schema checks on a parsed workflow document map.
func ValidateDocMap(doc map[string]any) []DocIssue {
	c := &checker{}
	c.checkDoc(doc)
	out := make([]DocIssue, len(c.issues.list))
	for i, iss := range c.issues.list {
		out[i] = DocIssue{Path: docIssuePath(iss.step, iss.key), Message: iss.msg}
	}
	return out
}

// ParseRawWithDoc parses YAML text and returns the document map for structured tooling.
func ParseRawWithDoc(file, text string) (map[string]any, error) {
	if _, err := ParseRaw(file, text); err != nil {
		return nil, err
	}
	var data any
	if err := yaml.Unmarshal([]byte(text), &data); err != nil {
		return nil, bail(file, 0, "", err.Error())
	}
	doc, ok := data.(map[string]any)
	if !ok || doc == nil {
		return nil, bail(file, 0, "", "workflow document must be a mapping")
	}
	return doc, nil
}
