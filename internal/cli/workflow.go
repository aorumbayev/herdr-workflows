package cli

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

func runWorkflowImport(cmd *cobra.Command, args []string) error {
	toFlag, err := cmd.Flags().GetString("to")
	if err != nil {
		return err
	}
	if toFlag != "" && toFlag != "repo" && toFlag != "global" {
		return fmt.Errorf("invalid argument %q for \"--to\" flag: choices are repo, global", toFlag)
	}
	yes, err := cmd.Flags().GetBool("yes")
	if err != nil {
		return err
	}
	force, err := cmd.Flags().GetBool("force")
	if err != nil {
		return err
	}

	stdinTTY := false
	stdoutTTY := false
	if f, ok := cmd.InOrStdin().(*os.File); ok {
		stdinTTY = term.IsTerminal(int(f.Fd()))
	}
	if f, ok := cmd.OutOrStdout().(*os.File); ok {
		stdoutTTY = term.IsTerminal(int(f.Fd()))
	}
	tty := stdinTTY && stdoutTTY
	preapproved := yes

	var scope workflow.ImportScope
	switch toFlag {
	case "repo":
		scope = workflow.ImportRepo
	case "global":
		scope = workflow.ImportGlobal
	}
	if !tty && (!preapproved || scope == "") {
		return fmt.Errorf("not a tty: pass --yes and --to=repo|global to import without the review prompts")
	}

	repoRoot := os.Getenv("HERDR_WORKFLOWS_REPO_ROOT")
	if repoRoot == "" {
		wd, wdErr := os.Getwd()
		if wdErr != nil {
			return wdErr
		}
		repoRoot = config.ResolveRepoRoot(wd)
	}

	opts := workflow.RunImportOptions{
		RepoRoot: repoRoot,
		Scope:    scope,
		Force:    force,
	}
	if !preapproved {
		opts.Prompts = importPrompts(cmd.InOrStdin(), cmd.OutOrStdout(), repoRoot)
	}

	outcome, importErr := workflow.RunImport(args[0], opts)
	if importErr != nil {
		return importErr
	}
	out := cmd.OutOrStdout()
	if outcome.Aborted {
		if _, err := fmt.Fprint(out, "aborted — nothing written\n"); err != nil {
			return err
		}
		return nil
	}
	if outcome.Result.Status == "conflicts" {
		names := make([]string, len(outcome.Result.Conflicts))
		for i, c := range outcome.Result.Conflicts {
			names[i] = c.Name
		}
		return fmt.Errorf("existing workflows would be replaced (%s); pass --force to replace all", strings.Join(names, ", "))
	}
	for _, row := range outcome.Result.Results {
		if _, err := fmt.Fprintf(out, "wrote %s\n", row.Path); err != nil {
			return err
		}
	}
	return nil
}

func runWorkflowValidate(cmd *cobra.Command, args []string) error {
	path := args[0]
	name := ""
	if len(args) > 1 {
		name = args[1]
	}
	if name == "" {
		base := filepath.Base(path)
		name = strings.TrimSuffix(base, filepath.Ext(base))
	}
	repoRoot := os.Getenv("HERDR_WORKFLOWS_REPO_ROOT")
	if repoRoot == "" {
		wd, wdErr := os.Getwd()
		if wdErr != nil {
			return writeValidateJSON(cmd.OutOrStdout(), false, wdErr.Error())
		}
		repoRoot = config.ResolveRepoRoot(wd)
	}
	result := workflow.ValidateFile(path, name, repoRoot)
	return writeValidateJSON(cmd.OutOrStdout(), result.OK, result.Error)
}

func writeValidateJSON(out io.Writer, ok bool, errMsg string) error {
	payload := map[string]any{"ok": ok}
	if !ok {
		payload["error"] = errMsg
	}
	enc := json.NewEncoder(out)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(payload); err != nil {
		return err
	}
	if !ok {
		return &exitCodeError{code: 1, msg: errMsg}
	}
	return nil
}

func runWorkflowInspect(cmd *cobra.Command, args []string) error {
	rawInputs, err := cmd.Flags().GetStringArray("input")
	if err != nil {
		return err
	}
	resolve, err := cmd.Flags().GetBool("resolve")
	if err != nil {
		return err
	}
	provided, err := parseInputs(rawInputs)
	if err != nil {
		return err
	}

	appCtx, err := config.LoadContext(config.LoadOptions{})
	if err != nil {
		return err
	}
	wf, err := workflow.LoadWorkflow(args[0], appCtx.RepoRoot, appCtx.Config)
	if err != nil {
		return err
	}
	for key := range provided {
		found := false
		for _, input := range wf.Inputs {
			if input.Name == key {
				found = true
				break
			}
		}
		if !found {
			return fmt.Errorf("unknown input %q", key)
		}
	}

	domains := map[string][]string{}
	values := map[string]string{}
	for key, val := range provided {
		values[key] = val
	}
	if resolve {
		var resolveErr error
		domains, resolveErr = resolveInspectDomains(wf, appCtx.RepoRoot, provided, values)
		if resolveErr != nil {
			return resolveErr
		}
	}

	lines := []string{fmt.Sprintf("workflow: %s", wf.Name), "inputs:"}
	if len(wf.Inputs) == 0 {
		lines = append(lines, "  (none)")
	} else {
		for _, spec := range wf.Inputs {
			var resolved []string
			if resolve {
				resolved = domains[spec.Name]
			}
			for _, line := range formatInputInspect(spec, resolved) {
				lines = append(lines, "  "+line)
			}
		}
	}
	if _, err := fmt.Fprintf(cmd.OutOrStdout(), "%s\n", strings.Join(lines, "\n")); err != nil {
		return err
	}
	return nil
}

func runUpdate(cmd *cobra.Command, _ []string) error {
	return executeUpdate(defaultUpdateDeps(), cmd.OutOrStdout(), cmd.ErrOrStderr())
}

func importPrompts(in io.Reader, out io.Writer, repoRoot string) *workflow.ImportPrompts {
	return &workflow.ImportPrompts{
		Confirm: func(preview string) (bool, error) {
			if _, err := fmt.Fprintf(out, "%s\n\n%s\n", workflow.ImportDisclaimer, preview); err != nil {
				return false, err
			}
			if _, err := fmt.Fprint(out, "Reviewed the workflow above and want it? [y/N] "); err != nil {
				return false, err
			}
			return readYes(in)
		},
		ChooseScope: func() (workflow.ImportScope, error) {
			if _, err := fmt.Fprintf(out, "Install into [r]epo %s/.hwf / [g]lobal ~/.hwf [R]: ", repoRoot); err != nil {
				return workflow.ImportRepo, err
			}
			line, readErr := readLine(in)
			if readErr != nil {
				return workflow.ImportRepo, readErr
			}
			if line == "" {
				return workflow.ImportRepo, nil
			}
			parsed, ok := workflow.ParseImportScope(line)
			if !ok {
				return workflow.ImportRepo, nil
			}
			return parsed, nil
		},
	}
}

func resolveInspectDomains(
	wf *workflow.Definition,
	repoRoot string,
	provided map[string]string,
	values map[string]string,
) (map[string][]string, error) {
	domains := map[string][]string{}
	ns := workflow.TemplateNamespace{
		Inputs:  map[string]any{},
		Steps:   map[string]any{},
		Context: map[string]any{},
	}
	for key, val := range values {
		ns.Inputs[key] = val
	}
	for _, spec := range wf.Inputs {
		if !workflow.EvaluateWhen(spec.When, ns) {
			continue
		}
		if spec.Default != nil && !hasKey(values, spec.Name) {
			values[spec.Name] = *spec.Default
			ns.Inputs[spec.Name] = *spec.Default
		}
		if spec.DynamicOptions == nil || !dynamicChoiceInputsProvided(*spec.DynamicOptions, provided) {
			continue
		}
		choices, err := workflow.ResolveDynamicChoices(
			context.Background(),
			wf.File,
			spec.Name,
			*spec.DynamicOptions,
			repoRoot,
			values,
		)
		if err != nil {
			return nil, err
		}
		domains[spec.Name] = choices
	}
	return domains, nil
}

func dynamicChoiceInputsProvided(dynamic workflow.DynamicChoice, provided map[string]string) bool {
	for _, ref := range workflow.DynamicChoiceInputRefs(dynamic) {
		if !hasKey(provided, ref) {
			return false
		}
	}
	return true
}

func formatWhenClause(clause workflow.WhenSpec) string {
	if clause.Kind == workflow.WhenTruthy {
		return fmt.Sprintf("{{%s}}", clause.Path)
	}
	op := "=="
	if clause.Negate {
		op = "!="
	}
	encoded, _ := json.Marshal(clause.Value)
	return fmt.Sprintf("{{%s}} %s %s", clause.Path, op, string(encoded))
}

func formatInputInspect(spec workflow.InputSpec, resolved []string) []string {
	lines := []string{spec.Name + ":"}
	lines = append(lines, "  type: "+spec.Type)
	if spec.Description != "" {
		lines = append(lines, "  description: "+spec.Description)
	}
	if len(spec.When) > 0 {
		text := formatWhenClause(spec.When[0])
		if len(spec.When) > 1 {
			parts := make([]string, len(spec.When))
			for i, clause := range spec.When {
				parts[i] = formatWhenClause(clause)
			}
			text = "[" + strings.Join(parts, ", ") + "]"
		}
		lines = append(lines, "  when: "+text)
	}
	if spec.Default != nil {
		lines = append(lines, "  default: "+*spec.Default)
	}
	if spec.MinLength != nil {
		lines = append(lines, fmt.Sprintf("  min_length: %d", *spec.MinLength))
	}
	if spec.AllowCustom {
		lines = append(lines, "  allow_custom: true")
	}
	if spec.DynamicOptions != nil {
		parts := make([]string, len(spec.DynamicOptions.Run))
		for i, el := range spec.DynamicOptions.Run {
			encoded, _ := json.Marshal(el)
			parts[i] = string(encoded)
		}
		lines = append(lines, "  options.run: ["+strings.Join(parts, ", ")+"]")
		if resolved != nil {
			resParts := make([]string, len(resolved))
			for i, el := range resolved {
				encoded, _ := json.Marshal(el)
				resParts[i] = string(encoded)
			}
			lines = append(lines, "  options: ["+strings.Join(resParts, ", ")+"]")
		}
	} else if len(spec.Options) > 0 {
		parts := make([]string, len(spec.Options))
		for i, el := range spec.Options {
			encoded, _ := json.Marshal(el)
			parts[i] = string(encoded)
		}
		lines = append(lines, "  options: ["+strings.Join(parts, ", ")+"]")
	}
	return lines
}

func readLine(in io.Reader) (string, error) {
	scanner := bufio.NewScanner(in)
	if !scanner.Scan() {
		if err := scanner.Err(); err != nil {
			return "", err
		}
		return "", io.EOF
	}
	return scanner.Text(), nil
}

func readYes(in io.Reader) (bool, error) {
	line, err := readLine(in)
	if err != nil {
		if err == io.EOF {
			return false, nil
		}
		return false, err
	}
	return strings.EqualFold(strings.TrimSpace(line), "y"), nil
}

func hasKey(m map[string]string, key string) bool {
	_, ok := m[key]
	return ok
}
