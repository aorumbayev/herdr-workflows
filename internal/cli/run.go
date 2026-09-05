package cli

import (
	"errors"
	"fmt"
	"io"
	"os"
	"syscall"

	"github.com/aorumbayev/herdr-workflows/internal/caps"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/engine"
	"github.com/aorumbayev/herdr-workflows/internal/history"
	"github.com/aorumbayev/herdr-workflows/internal/host"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
	"github.com/spf13/cobra"
)

func runRun(cmd *cobra.Command, args []string) error {
	name := args[0]
	rawInputs, err := cmd.Flags().GetStringArray("input")
	if err != nil {
		return err
	}
	detach, _ := cmd.Flags().GetBool("detach")
	jsonOut, _ := cmd.Flags().GetBool("json")
	if detach != jsonOut {
		return errors.New("--detach and --json must be used together")
	}
	if detach {
		return runDetachedJSON(cmd, name, rawInputs)
	}
	if err := host.EnsureHerdrProtocol(); err != nil {
		return err
	}

	launchPayload, err := cmd.Flags().GetBool("launch-payload")
	if err != nil {
		return err
	}

	inputs := map[string]string{}
	var payload engine.LaunchPayload
	if launchPayload {
		payload, err = loadLaunchPayload(cmd, name)
		if err != nil {
			return err
		}
		inputs = payload.Inputs
	}

	flagInputs, err := parseInputs(rawInputs)
	if err != nil {
		return fmt.Errorf("invalid inputs: %w", err)
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
		Workflow:       *loaded,
		RunID:          payload.RunID,
		CheckoutRoot:   app.RepoRoot,
		RequireHistory: payload.RequireHistory,
		OnAck: func(line string) {
			writeRunLine(stdout, line)
		},
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
		Domains:  payload.Domains,
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
	if runIsDetached(cmd) {
		notifyRunOutcome(recorder.RunID(), workflow.DisplayTitle(loaded.Name, loaded.Title))
	}
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

func loadLaunchPayload(cmd *cobra.Command, name string) (engine.LaunchPayload, error) {
	stdin, err := io.ReadAll(io.LimitReader(cmd.InOrStdin(), int64(caps.CaptureByteLimit)+1))
	if err != nil {
		return engine.LaunchPayload{}, err
	}
	if err := caps.AssertUnderCaptureCap("launch payload", string(stdin)); err != nil {
		return engine.LaunchPayload{}, err
	}
	payload, err := engine.ParseLaunchPayload(string(stdin))
	if err != nil {
		return engine.LaunchPayload{}, err
	}
	if payload.Name != name {
		return engine.LaunchPayload{}, fmt.Errorf("launch payload name '%s' does not match run name '%s'", payload.Name, name)
	}
	return payload, nil
}
