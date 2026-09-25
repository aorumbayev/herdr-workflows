package cli

import (
	"errors"
	"fmt"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/engine"
	"github.com/aorumbayev/herdr-workflows/internal/history"
	"github.com/aorumbayev/herdr-workflows/internal/host"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
	"github.com/spf13/cobra"
)

type retryRequest struct {
	runID      string
	fromFailed bool
}

type preparedRetry struct {
	workflow *workflow.Definition
	resume   *engine.Resume
	sourceID string
	inputs   map[string]string
	domains  map[string][]string
}

func runRetry(cmd *cobra.Command, args []string) error {
	if err := host.EnsureHerdrProtocol(); err != nil {
		return err
	}
	fromFailed, err := cmd.Flags().GetBool("from-failed")
	if err != nil {
		return err
	}
	return executeRun(cmd, runRequest{retry: &retryRequest{runID: args[0], fromFailed: fromFailed}})
}

func prepareRetry(app config.AppContext, req runRequest) (preparedRetry, error) {
	rec, err := history.LoadRetryRecord(req.retry.runID, time.Now())
	if err != nil {
		return preparedRetry{}, err
	}
	if rec.Status == "running" {
		return preparedRetry{}, fmt.Errorf("run %s is still running", rec.ID)
	}
	if req.name != "" && req.name != rec.Workflow {
		return preparedRetry{}, fmt.Errorf("run %s belongs to workflow '%s', not '%s'", rec.ID, rec.Workflow, req.name)
	}
	if len(req.inputs) > 0 {
		return preparedRetry{}, errors.New("a retry replays the recorded inputs; --input is not accepted")
	}
	if root := history.CanonicalRepoRoot(app.RepoRoot); root != rec.CheckoutRoot {
		return preparedRetry{}, fmt.Errorf("run %s started in %s; run it from there", rec.ID, rec.CheckoutRoot)
	}
	loaded, err := workflow.LoadWorkflow(rec.Workflow, app.RepoRoot, app.Config)
	if err != nil {
		return preparedRetry{}, err
	}
	var resume *engine.Resume
	if req.retry.fromFailed {
		resume, err = engine.PlanResume(loaded, rec.Source)
		if err != nil {
			return preparedRetry{}, fmt.Errorf("cannot resume run %s: %w", rec.ID, err)
		}
	}
	inputs, domains := declaredInputs(loaded, rec.Inputs, rec.Domains)
	return preparedRetry{workflow: loaded, resume: resume, sourceID: rec.ID, inputs: inputs, domains: domains}, nil
}

// declaredInputs drops recorded inputs that the current workflow no longer declares.
func declaredInputs(wf *workflow.Definition, values map[string]string, domains map[string][]string) (map[string]string, map[string][]string) {
	keptValues := map[string]string{}
	keptDomains := map[string][]string{}
	for _, input := range wf.Inputs {
		if v, ok := values[input.Name]; ok {
			keptValues[input.Name] = v
		}
		if d, ok := domains[input.Name]; ok && input.Type == "choice" && input.DynamicOptions != nil {
			keptDomains[input.Name] = d
		}
	}
	return keptValues, keptDomains
}
