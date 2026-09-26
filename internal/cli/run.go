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

type runRequest struct {
	name     string
	inputs   map[string]string
	domains  map[string][]string
	runID    string
	detached bool
	retry    *retryRequest
}

func runRun(cmd *cobra.Command, args []string) error {
	if err := host.EnsureHerdrProtocol(); err != nil {
		return err
	}

	req := runRequest{name: args[0], inputs: map[string]string{}}
	launchPayload, err := cmd.Flags().GetBool("launch-payload")
	if err != nil {
		return err
	}
	rawInputs, err := cmd.Flags().GetStringArray("input")
	if err != nil {
		return err
	}

	if launchPayload {
		payload, err := loadLaunchPayload(cmd, req.name)
		if err != nil {
			return err
		}
		req.inputs, req.domains, req.runID, req.detached = payload.Inputs, payload.Domains, payload.RunID, true
		if payload.RetryOf != "" {
			req.retry = &retryRequest{runID: payload.RetryOf, fromFailed: payload.FromFailed}
		}
	}

	flagInputs, err := parseInputs(rawInputs)
	if err != nil {
		return fmt.Errorf("invalid inputs: %w", err)
	}
	for key, val := range flagInputs {
		req.inputs[key] = val
	}
	return executeRun(cmd, req)
}

func executeRun(cmd *cobra.Command, req runRequest) error {
	app, err := config.LoadContext(config.LoadOptions{})
	if err != nil {
		return err
	}

	var loaded *workflow.Definition
	var resume *engine.Resume
	var retryContext map[string]any
	retryOf := ""
	if req.retry != nil {
		prepared, err := prepareRetry(app, req)
		if err != nil {
			return err
		}
		loaded, resume, retryOf, retryContext = prepared.workflow, prepared.resume, prepared.sourceID, prepared.context
		req.inputs, req.domains = prepared.inputs, prepared.domains
	} else {
		loaded, err = workflow.LoadWorkflow(req.name, app.RepoRoot, app.Config)
		if err != nil {
			return err
		}
	}

	stdout := cmd.OutOrStdout()
	stderr := cmd.ErrOrStderr()

	recorder, err := history.CreateRunRecorder(history.CreateRecorderOpts{
		Workflow:     *loaded,
		RunID:        req.runID,
		CheckoutRoot: app.RepoRoot,
		RetryOf:      retryOf,
		OnAck: func(line string) {
			writeRunLine(stdout, line)
		},
	})
	if err != nil {
		return err
	}

	runOpts := engine.RunOptions{
		Name:         loaded.Name,
		RepoRoot:     app.RepoRoot,
		Config:       app.Config,
		Ctx:          app.Ctx,
		Deps:         liveRunnerDeps(),
		Inputs:       req.inputs,
		Domains:      req.domains,
		Recorder:     recorder,
		Workflow:     loaded,
		Resume:       resume,
		RetryContext: retryContext,
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
	if req.detached {
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
