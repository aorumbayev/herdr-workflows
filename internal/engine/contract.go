package engine

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/host"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

type StepActionKind string

const (
	ActionAgent    StepActionKind = "agent"
	ActionRun      StepActionKind = "run"
	ActionHerdr    StepActionKind = "herdr"
	ActionWorkflow StepActionKind = "workflow"
)

type StepFailure struct {
	Message      string
	Workflow     string
	Action       StepActionKind
	StepNumber   int
	WorkflowPath []string
	StepID       string
	Details      map[string]any
}

type StepOutcome struct {
	OK               bool
	Result           any
	Launched         bool
	Truncated        bool
	Error            string
	Details          map[string]any
	CoordinationLost bool
	HardFailure      bool
	Failure          *StepFailure
}

type StepFrame struct {
	Step      workflow.Step
	StepIndex int
	Values    workflow.TemplateNamespace
	Opts      StepRunOpts
}

type StepsResult struct {
	OK               bool
	Failures         []string
	Error            string
	Aborted          bool
	CoordinationLost bool
	Failure          *StepFailure
}

type RecorderScope struct {
	Name          string
	WorkflowPath  []string
	ParentOrdinal *int
}

type StepPhase string

const (
	PhaseMain     StepPhase = "main"
	PhaseRecovery StepPhase = "recovery"
)

type StepOutcomeKind string

const (
	OutcomeSucceeded       StepOutcomeKind = "succeeded"
	OutcomeSkipped         StepOutcomeKind = "skipped"
	OutcomeLaunched        StepOutcomeKind = "launched"
	OutcomeFailedContinued StepOutcomeKind = "failed_continued"
	OutcomeFailed          StepOutcomeKind = "failed"
	OutcomeInterrupted     StepOutcomeKind = "interrupted"
)

type RunTerminalStatus string

const (
	StatusSucceeded   RunTerminalStatus = "succeeded"
	StatusFailed      RunTerminalStatus = "failed"
	StatusInterrupted RunTerminalStatus = "interrupted"
)

type RecorderOutcome struct {
	OK               bool
	Truncated        bool
	Error            string
	Details          map[string]any
	CoordinationLost bool
}

type RecorderFinishExtras struct {
	Returns any
	Error   string
}

type Recorder interface {
	RunID() string
	Child(scope RecorderScope) Recorder
	StepStarted(step workflow.Step, ordinal, total int, label string, phase StepPhase) error
	StepFinished(step workflow.Step, ordinal, total int, label string, kind StepOutcomeKind, outcome *RecorderOutcome, phase StepPhase) error
	Finished(status RunTerminalStatus, extras *RecorderFinishExtras) error
	Dispose()
}

type ProgressOutcome string

const (
	ProgressStart  ProgressOutcome = "start"
	ProgressOk     ProgressOutcome = "ok"
	ProgressSkip   ProgressOutcome = "skip"
	ProgressFail   ProgressOutcome = "fail"
	ProgressLaunch ProgressOutcome = "launch"
)

type TranscriptTextOpts struct {
	InvocationCwd string
	ProjectsBase  string
}

type RunnerDeps struct {
	HerdrCall        func(method string, params map[string]any) (map[string]any, error)
	NotificationShow func(title string, body *string) error
	AgentStatus      func(target string) (string, error)
	AgentInfo        func(target string) (map[string]any, error)
	PaneClose        func(paneID string) error
	TabClose         func(tabID string) error
	ReportToken      func(paneID string, value *string) error
	TranscriptText   func(paneID string, transcripts map[string]config.TranscriptExtractor, opts TranscriptTextOpts) (string, error)
	Sleep            func(d time.Duration)
	Now              func() time.Time
	ResponseDir      *string
}

type StepRunOpts struct {
	Name                 string
	RepoRoot             string
	Config               config.Config
	Ctx                  config.InvocationContext
	Deps                 RunnerDeps
	RunID                string
	WorkflowPath         []string
	Children             map[string]*workflow.Definition
	ManagedResponseFiles *[]string
	Recorder             Recorder
	OnProgress           func(step, total int, label string, outcome *ProgressOutcome)
	OnStderr             func(text string)
	RunSteps             func(steps []workflow.Step, opts StepRunOpts, values workflow.TemplateNamespace) (StepsResult, error)
	Env                  []string
}

type CoordinationError struct {
	message string
}

func (e *CoordinationError) Error() string {
	return e.message
}

func NewCoordinationError(action, detail string) *CoordinationError {
	msg := fmt.Sprintf("%s: herdr coordination was lost (%s) — the action may still be active; panes were preserved and on_failure was skipped", action, detail)
	return &CoordinationError{message: msg}
}

func IsCoordinationError(err error) bool {
	return host.IsTransportLoss(err)
}

func ErrorText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func ReadTruncated(result any) bool {
	if result == nil {
		return false
	}
	m, ok := result.(map[string]any)
	if !ok {
		return false
	}
	read, ok := m["read"].(map[string]any)
	if !ok {
		return false
	}
	truncated, ok := read["truncated"].(bool)
	return ok && truncated
}

func DispatchFailure(action string, err error) StepOutcome {
	if IsCoordinationError(err) {
		return StepOutcome{
			OK:               false,
			Error:            NewCoordinationError(action, ErrorText(err)).Error(),
			CoordinationLost: true,
		}
	}
	return StepOutcome{
		OK:    false,
		Error: fmt.Sprintf("%s: %s", action, ErrorText(err)),
	}
}

func RunScratchDir(repoRoot string) string {
	return filepath.Join(repoRoot, ".hwf", "tmp")
}

func EnsureRunScratchDir(repoRoot, dir string) (string, error) {
	if dir == "" {
		dir = RunScratchDir(repoRoot)
	}

	if err := config.EnsureLocalConfigGitignored(repoRoot); err != nil {
		return "", err
	}

	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}

	if err := os.Chmod(dir, 0o700); err != nil {
		return "", err
	}

	return dir, nil
}

func trackManagedResponseFile(opts *StepRunOpts, path string) {
	if opts.ManagedResponseFiles == nil {
		files := []string{path}
		opts.ManagedResponseFiles = &files
		return
	}
	*opts.ManagedResponseFiles = append(*opts.ManagedResponseFiles, path)
}
