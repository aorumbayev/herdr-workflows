package caps

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"
)

type SpawnOpts struct {
	Cwd              string
	Stdin            *string
	Env              []string
	TimeoutMs        int
	Ctx              context.Context
	MaxCaptureSource string
}

type SpawnResult struct {
	TimedOut  bool
	ExitCode  int
	Stdout    string
	Stderr    string
	TimeoutMs int
}

// KillSpawn kills the whole process group, then the process as fallback.
func KillSpawn(cmd *exec.Cmd) {
	if cmd.Process == nil || cmd.Process.Pid == 0 {
		return
	}
	pid := cmd.Process.Pid
	if syscall.Kill(-pid, syscall.SIGKILL) == nil {
		return
	}
	_ = cmd.Process.Kill()
}

type captureBudget struct {
	mu         sync.Mutex
	limit      int
	total      int
	overflow   bool
	source     string
	onOverflow func()
}

type budgetWriter struct {
	budget *captureBudget
	dst    *bytes.Buffer
}

func (w *budgetWriter) Write(p []byte) (int, error) {
	w.budget.mu.Lock()
	defer w.budget.mu.Unlock()

	if !w.budget.overflow {
		w.budget.total += len(p)
		if w.budget.total > w.budget.limit {
			w.budget.overflow = true
			w.budget.onOverflow()
		}
	}

	if w.budget.overflow {
		return len(p), nil
	}

	return w.dst.Write(p)
}

func extractExitCode(err error) int {
	if err == nil {
		return 0
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode()
	}
	return 1
}

// waitForCmd blocks on nil timer and ctx channels when neither bound is set.
func waitForCmd(done chan error, opts SpawnOpts, cmd *exec.Cmd) (int, bool) {
	var timer <-chan time.Time
	if opts.TimeoutMs > 0 {
		timer = time.After(time.Duration(opts.TimeoutMs) * time.Millisecond)
	}
	var cancelled <-chan struct{}
	if opts.Ctx != nil {
		cancelled = opts.Ctx.Done()
	}

	select {
	case err := <-done:
		return extractExitCode(err), false
	case <-timer:
	case <-cancelled:
	}
	KillSpawn(cmd)
	<-done
	return -1, true
}

// Spawn runs argv with captured output bounded by CaptureByteLimit.
func Spawn(argv []string, opts SpawnOpts) (SpawnResult, error) {
	var stdoutBuf, stderrBuf bytes.Buffer
	result := SpawnResult{TimeoutMs: opts.TimeoutMs}

	if len(argv) == 0 {
		return result, errors.New("empty command argv")
	}

	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = opts.Cwd
	cmd.Env = opts.Env
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	var budget *captureBudget
	if opts.MaxCaptureSource != "" {
		budget = &captureBudget{
			limit:      CaptureByteLimit,
			source:     opts.MaxCaptureSource,
			onOverflow: func() { KillSpawn(cmd) },
		}
		cmd.Stdout = &budgetWriter{budget: budget, dst: &stdoutBuf}
		cmd.Stderr = &budgetWriter{budget: budget, dst: &stderrBuf}
	} else {
		cmd.Stdout = &stdoutBuf
		cmd.Stderr = &stderrBuf
	}

	if opts.Stdin != nil {
		cmd.Stdin = strings.NewReader(*opts.Stdin)
	} else {
		cmd.Stdin = strings.NewReader("")
	}

	if err := cmd.Start(); err != nil {
		return result, err
	}

	done := make(chan error, 1)

	go func() {
		done <- cmd.Wait()
	}()

	exitCode, timedOut := waitForCmd(done, opts, cmd)
	result.ExitCode = exitCode
	result.TimedOut = timedOut

	if budget != nil && budget.overflow {
		return result, &CaptureLimitError{
			Source: budget.source,
			Bytes:  budget.total,
			Limit:  budget.limit,
		}
	}

	result.Stdout = stdoutBuf.String()
	result.Stderr = stderrBuf.String()

	return result, nil
}
