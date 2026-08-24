package cli

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"

	assets "github.com/aorumbayev/herdr-workflows/embed"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

var errUsage = errors.New("usage")

type streams struct {
	in        io.Reader
	out       io.Writer
	err       io.Writer
	stdinTTY  bool
	stdoutTTY bool
}

func stdIO(in io.Reader, out, err io.Writer) streams {
	s := streams{in: in, out: out, err: err}
	if f, ok := in.(*os.File); ok {
		s.stdinTTY = term.IsTerminal(int(f.Fd()))
	}
	if f, ok := out.(*os.File); ok {
		s.stdoutTTY = term.IsTerminal(int(f.Fd()))
	}
	return s
}

// Main operates the hwf command tree and gives a process exit code.
func Main(args []string, in io.Reader, out, err io.Writer) int {
	signal.Ignore(syscall.SIGPIPE)
	return run(args, stdIO(in, out, err))
}

func run(args []string, ioStreams streams) int {
	root := newRoot()
	root.SetIn(ioStreams.in)
	root.SetOut(ioStreams.out)
	root.SetErr(ioStreams.err)
	root.SetArgs(args)
	if execErr := root.Execute(); execErr != nil {
		if errors.Is(execErr, errUsage) {
			return 1
		}
		_, _ = fmt.Fprintln(ioStreams.err, execErr.Error())
		var ec interface{ ExitCode() int }
		if errors.As(execErr, &ec) {
			return ec.ExitCode()
		}
		return 1
	}
	return 0
}

func newRoot() *cobra.Command {
	root := &cobra.Command{
		Use:           "hwf",
		Short:         assets.ManifestDescription(),
		SilenceErrors: true,
		SilenceUsage:  true,
		RunE: func(cmd *cobra.Command, args []string) error {
			cmd.SetOut(cmd.ErrOrStderr())
			_ = cmd.Help()
			return errUsage
		},
	}
	root.Version = assets.ManifestVersion()
	root.SetVersionTemplate("{{.Version}}\n")
	root.CompletionOptions.DisableDefaultCmd = true
	root.Flags().BoolP("version", "V", false, "version for hwf")
	root.InitDefaultVersionFlag()
	root.SetFlagErrorFunc(func(_ *cobra.Command, err error) error {
		msg := err.Error()
		msg = strings.Replace(msg, "unknown flag", "unknown option", 1)
		msg = strings.Replace(msg, "unknown shorthand flag", "unknown option", 1)
		return fmt.Errorf("%s", msg)
	})
	root.SetHelpTemplate(rootHelpTemplate())
	root.AddCommand(
		newRunCmd(),
		newInitCmd(),
		newWorkflowCmd(),
		newLaunchCmd(),
		newPickerCmd(),
		newConsoleCmd(),
		newEditorCmd(),
		newUpdateCmd(),
		newSkillsCmd(),
		newScratchCmd(),
		newResponseCmd(),
		newSetupCmd(),
	)
	return root
}

func rootHelpTemplate() string {
	return `Usage:{{if .Runnable}}
  {{.UseLine}}{{end}}{{if .HasAvailableSubCommands}}
  {{.CommandPath}} [command]{{end}}

{{.Short}}

Workflow format: ` + workflow.Format + `

Commands:{{range .Commands}}{{if (or .IsAvailableCommand (eq .Name "help"))}}
  {{rpad .Name .NamePadding }} {{.Short}}{{end}}{{end}}{{if .HasAvailableLocalFlags}}

Flags:
{{.LocalFlags.FlagUsages | trimTrailingWhitespaces}}{{end}}
`
}
