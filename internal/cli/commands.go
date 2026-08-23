package cli

import (
	"fmt"

	"github.com/spf13/cobra"
)

func newRunCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "run <name>",
		Short: "Run a workflow by name",
		Args: func(_ *cobra.Command, args []string) error {
			if len(args) < 1 {
				return fmt.Errorf("missing required argument 'name'")
			}
			if len(args) > 1 {
				return fmt.Errorf("accepts 1 arg(s), received %d", len(args))
			}
			return nil
		},
		RunE: runRun,
	}
	cmd.Flags().StringArray("input", nil, "workflow input (repeatable)")
	cmd.Flags().Bool("launch-payload", false, "read launch payload JSON from stdin")
	return cmd
}

func newInitCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "init",
		Short: "Write local or global plugin config",
		RunE:  runInitCmd,
	}
	cmd.Flags().Bool("force", false, "overwrite existing config without prompting")
	cmd.Flags().Bool("global", false, "write global plugin config")
	return cmd
}

func newWorkflowCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "workflow",
		Short: "Workflow maintenance commands",
		RunE: func(c *cobra.Command, args []string) error {
			c.SetOut(c.ErrOrStderr())
			_ = c.Help()
			return errUsage
		},
	}
	imp := &cobra.Command{
		Use:   "import <payload>",
		Short: "Import a shared workflow bundle",
		Args:  cobra.ExactArgs(1),
		RunE:  runWorkflowImport,
	}
	imp.Flags().String("to", "", "repo or global destination")
	_ = imp.RegisterFlagCompletionFunc("to", cobra.FixedCompletions([]string{"repo", "global"}, cobra.ShellCompDirectiveNoFileComp))
	imp.Flags().BoolP("yes", "y", false, "skip interactive confirmation")
	imp.Flags().Bool("force", false, "replace conflicting workflows")
	insp := &cobra.Command{
		Use:   "inspect <name>",
		Short: "Print workflow input metadata",
		Args:  cobra.ExactArgs(1),
		RunE:  runWorkflowInspect,
	}
	insp.Flags().StringArray("input", nil, "select guarded input path (repeatable)")
	insp.Flags().Bool("resolve", false, "resolve active dynamic choices")
	val := &cobra.Command{
		Use:   "validate <file> [name]",
		Short: "Validate a workflow YAML file through the loader",
		Args:  cobra.RangeArgs(1, 2),
		RunE:  runWorkflowValidate,
	}
	cmd.AddCommand(imp, insp, val)
	return cmd
}

func newLaunchCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "launch",
		Short: "Open the workflow picker popup",
		RunE:  runLaunch,
	}
}

func newPickerCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "picker",
		Short: "Run the picker TUI (plugin popup entrypoint)",
		RunE:  runPicker,
	}
}

func newConsoleCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "console",
		Short: "Open or run the full-screen console TUI",
		RunE:  runConsole,
	}
	cmd.Flags().String("placement", "", "open placement: tab, beside, or below (default beside when opening)")
	return cmd
}

func newUpdateCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "update",
		Short: "Update to the latest published GitHub Release via Herdr",
		RunE:  runUpdate,
	}
}

func newSkillsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "skills",
		Short: "Print the bundled agent skills",
		RunE: func(c *cobra.Command, args []string) error {
			c.SetOut(c.ErrOrStderr())
			_ = c.Help()
			return errUsage
		},
	}
	cmd.AddCommand(
		&cobra.Command{
			Use:   "list",
			Short: "List the bundled skills with their descriptions",
			RunE:  runSkillsList,
		},
		&cobra.Command{
			Use:   "show <name>",
			Short: "Print one skill with its reference files",
			Args:  cobra.ExactArgs(1),
			RunE:  runSkillsShow,
		},
	)
	return cmd
}

func newResponseCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "response",
		Short: "Inspect an agent response file offline",
		RunE: func(c *cobra.Command, args []string) error {
			c.SetOut(c.ErrOrStderr())
			_ = c.Help()
			return errUsage
		},
	}
	check := &cobra.Command{
		Use:   "check <file>",
		Short: "Check the final verdict line of a response file against expected tokens",
		Args:  cobra.ExactArgs(1),
		RunE:  runResponseCheck,
	}
	check.Flags().String("one-of", "", "comma-separated verdict tokens")
	_ = check.MarkFlagRequired("one-of")
	cmd.AddCommand(check)
	return cmd
}

func newSetupCmd() *cobra.Command {
	return &cobra.Command{
		Use:    "setup",
		Short:  "Install PATH commands and picker keybindings",
		Hidden: true,
		RunE:   runSetup,
	}
}
