package transcript

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"sync"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/caps"
)

const transcriptTimeoutMs = 30_000

type captureResult struct {
	stdout    string
	stderr    string
	exitCode  int
	timedOut  bool
	timeoutMs int
}

type captureOptions struct {
	cwd       string
	env       []string
	timeoutMs int
}

// captureBudget is the maximum combined stdout and stderr byte count. It discards
// output that is more than the limit. os/exec copies each stream from its own
// goroutine, so a mutex controls access to the shared counters.
type captureBudget struct {
	mu       sync.Mutex
	limit    int
	total    int
	overflow bool
	stdout   bytes.Buffer
	stderr   bytes.Buffer
}

type streamWriter struct {
	budget *captureBudget
	dst    *bytes.Buffer
}

func (w *streamWriter) Write(p []byte) (int, error) {
	w.budget.mu.Lock()
	defer w.budget.mu.Unlock()
	if !w.budget.overflow {
		w.budget.total += len(p)
		if w.budget.total > w.budget.limit {
			w.budget.overflow = true
		}
	}
	if w.budget.overflow {
		return len(p), nil
	}
	return w.dst.Write(p)
}

// captureCommand runs argv with a timeout and a shared capture byte budget.
// The transcript cap is the maximum extractor output that is kept.
func captureCommand(argv []string, opts captureOptions) (captureResult, error) {
	ctx := context.Background()
	var cancel context.CancelFunc
	if opts.timeoutMs > 0 {
		ctx, cancel = context.WithTimeout(ctx, time.Duration(opts.timeoutMs)*time.Millisecond)
		defer cancel()
	}
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Dir = opts.cwd
	cmd.Env = opts.env
	budget := &captureBudget{limit: caps.CaptureByteLimit}
	cmd.Stdout = &streamWriter{budget: budget, dst: &budget.stdout}
	cmd.Stderr = &streamWriter{budget: budget, dst: &budget.stderr}

	runErr := cmd.Run()
	timedOut := ctx.Err() == context.DeadlineExceeded
	if budget.overflow {
		return captureResult{}, &caps.CaptureLimitError{Source: "transcript", Bytes: budget.total, Limit: caps.CaptureByteLimit}
	}
	exitCode := 0
	if runErr != nil {
		var exitErr *exec.ExitError
		// A timeout kills the child, so ExitCode is -1 in this branch.
		if !errors.As(runErr, &exitErr) {
			return captureResult{}, runErr
		}
		exitCode = exitErr.ExitCode()
	}
	return captureResult{
		stdout:    budget.stdout.String(),
		stderr:    budget.stderr.String(),
		exitCode:  exitCode,
		timedOut:  timedOut,
		timeoutMs: opts.timeoutMs,
	}, nil
}
