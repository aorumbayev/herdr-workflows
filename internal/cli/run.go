package cli

import (
	"errors"
	"fmt"
	"io"
	"os"
	"syscall"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/engine"
	"github.com/aorumbayev/herdr-workflows/internal/history"
	"github.com/aorumbayev/herdr-workflows/internal/host"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
	"github.com/spf13/cobra"
)

func runRun(cmd *cobra.Command, args []string) error {
	if err := host.EnsureHerdrProtocol(); err != nil {
		return err
	}

	name := args[0]
	launchPayload, err := cmd.Flags().GetBool("launch-payload")
	if err != nil {
		return err
	}
	rawInputs, err := cmd.Flags().GetStringArray("input")
	if err != nil {
		return err
	}

	inputs := map[string]string{}
	var domains map[string][]string
	var runID string

	if launchPayload {
		stdin, err := io.ReadAll(cmd.InOrStdin())
		if err != nil {
			return err
		}
		payload, err := engine.ParseLaunchPayload(string(stdin))
		if err != nil {
			return err
		}
		if payload.Name != name {
			return fmt.Errorf("launch payload name '%s' does not match run name '%s'", payload.Name, name)
		}
		inputs = payload.Inputs
		domains = payload.Domains
		runID = payload.RunID
	}

	flagInputs, err := parseInputs(rawInputs)
	if err != nil {
		return fmt.Errorf("invalid %s", err.Error())
	}
	for key, val := range flagInputs {
		inputs[key] = val
	}

	app, err := config.LoadContext(config.LoadOptions{})
	if err != nil {
		return err
	}

	loaded, err := workflow.LoadWorkflow(name, app.RepoRoot, app.Config)
	if err != nil {
		return err
	}

	stdout := cmd.OutOrStdout()
	stderr := cmd.ErrOrStderr()

	recorder, err := history.CreateRunRecorder(history.CreateRecorderOpts{
		Workflow:     *loaded,
		RunID:        runID,
		CheckoutRoot: app.RepoRoot,
		OnAck: func(line string) {
			writeRunLine(stdout, line)
		},
		Getenv: os.Getenv,
	})
	if err != nil {
		return err
	}

	runOpts := engine.RunOptions{
		Name:     name,
		RepoRoot: app.RepoRoot,
		Config:   app.Config,
		Ctx:      app.Ctx,
		Deps:     liveRunnerDeps(),
		Inputs:   inputs,
		Domains:  domains,
		Recorder: recorder,
		Workflow: loaded,
		OnProgress: func(step, total int, label string, outcome *engine.ProgressOutcome) {
			o := string(engine.ProgressStart)
			if outcome != nil {
				o = string(*outcome)
			}
			writeRunLine(stdout, history.FormatProgressLine(history.ProgressLine{
				Index: step, Total: total, Label: label, Outcome: o,
			}))
		},
		OnStderr: func(text string) {
			if text == "" {
				return
			}
			if !hasTrailingNewline(text) {
				text += "\n"
			}
			writeRunBytes(stderr, []byte(text))
		},
	}
	if launchPayload {
		resolveDynamic := false
		runOpts.ResolveDynamic = &resolveDynamic
	}

	result, err := engine.RunWorkflow(runOpts)
	if err != nil {
		var loadErr *workflow.LoadError
		if errors.As(err, &loadErr) {
			return loadErr
		}
		return err
	}
	if !result.OK {
		return errors.New(result.Error)
	}
	return nil
}

func hasTrailingNewline(text string) bool {
	return len(text) > 0 && text[len(text)-1] == '\n'
}

func writeRunLine(w io.Writer, line string) {
	writeRunBytes(w, []byte(line+"\n"))
}

func writeRunBytes(w io.Writer, data []byte) {
	if len(data) == 0 {
		return
	}
	if _, err := w.Write(data); err == nil {
		return
	} else if isClosedPipe(err) {
		return
	}
}

func isClosedPipe(err error) bool {
	var pathErr *os.PathError
	return errors.As(err, &pathErr) && errors.Is(pathErr.Err, syscall.EPIPE)
}
