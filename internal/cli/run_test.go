package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/caps"

	"github.com/aorumbayev/herdr-workflows/internal/host"
)

func runCLIEnv(t *testing.T, args []string, cwd string, extraEnv map[string]string, stdin string) cliResult {
	t.Helper()
	env := map[string]string{
		"HOME":                    t.TempDir(),
		"HERDR_PLUGIN_CONFIG_DIR": t.TempDir(),
		"HERDR_PLUGIN_STATE_DIR":  t.TempDir(),
	}
	for key, val := range extraEnv {
		env[key] = val
	}
	return runCLI(args, cwd, env, stdin)
}

func withPingSocket(t *testing.T, protocol int, version string, fn func(socketPath string)) {
	t.Helper()
	sockPath := filepath.Join("/tmp", fmt.Sprintf("hwf-cli-ping-%d-%d.sock", os.Getpid(), time.Now().UnixNano()))
	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = ln.Close()
		_ = os.Remove(sockPath)
	})
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer func() { _ = c.Close() }()
				buf := make([]byte, 4096)
				n, _ := c.Read(buf)
				if n == 0 {
					return
				}
				line := string(buf[:n])
				nl := strings.IndexByte(line, '\n')
				if nl >= 0 {
					line = line[:nl]
				}
				var req struct {
					ID string `json:"id"`
				}
				if err := json.Unmarshal([]byte(line), &req); err != nil {
					return
				}
				resp, _ := json.Marshal(map[string]any{
					"id": req.ID,
					"result": map[string]any{
						"type":     "pong",
						"protocol": protocol,
						"version":  version,
					},
				})
				_, _ = c.Write(append(resp, '\n'))
			}(conn)
		}
	}()
	fn(sockPath)
}

func TestRunResolvesWorkflowsViaRepoRootEnv(t *testing.T) {
	root := t.TempDir()
	elsewhere := t.TempDir()
	writeWorkflow(t, root, "hi", "version: v1alpha1\nsteps:\n  - run: \"printf ok\"\n")

	got := runCLIEnv(t, []string{"run", "hi"}, elsewhere, map[string]string{
		"HERDR_WORKFLOWS_REPO_ROOT": root,
	}, "")
	if got.code != 0 {
		t.Fatalf("code = %d stderr = %q", got.code, got.stderr)
	}
	if !strings.Contains(got.stdout, "[1/1]") {
		t.Fatalf("stdout = %q", got.stdout)
	}
}

func TestRunFromForeignCwdWithoutEnvFindsNothing(t *testing.T) {
	root := t.TempDir()
	elsewhere := t.TempDir()
	writeWorkflow(t, root, "hi", "version: v1alpha1\nsteps:\n  - run: \"printf ok\"\n")

	got := runCLIEnv(t, []string{"run", "hi"}, elsewhere, nil, "")
	if got.code != 1 {
		t.Fatalf("code = %d", got.code)
	}
	if !strings.Contains(got.stderr, "not found") {
		t.Fatalf("stderr = %q", got.stderr)
	}
}

func TestRunTreatsEmptyRepoRootEnvAsUnset(t *testing.T) {
	root := t.TempDir()
	writeWorkflow(t, root, "hi", "version: v1alpha1\nsteps:\n  - run: \"printf ok\"\n")

	got := runCLIEnv(t, []string{"run", "hi"}, root, map[string]string{
		"HERDR_WORKFLOWS_REPO_ROOT": "",
	}, "")
	if got.code != 0 {
		t.Fatalf("code = %d stderr = %q", got.code, got.stderr)
	}
	if !strings.Contains(got.stdout, "[1/1]") {
		t.Fatalf("stdout = %q", got.stdout)
	}
}

func TestRunAcceptsRepeatedAndEqualsFormInputFlags(t *testing.T) {
	root := t.TempDir()
	writeWorkflow(t, root, "echo-inputs", strings.Join([]string{
		"version: v1alpha1",
		"inputs:",
		"  a: text",
		"  b: text",
		"steps:",
		`  - run: [sh, -c, 'test "$1-$2" = "one-two"', sh, "{{inputs.a}}", "{{inputs.b}}"]`,
		"",
	}, "\n"))

	got := runCLIEnv(t, []string{"run", "echo-inputs", "--input", "a=one", "--input=b=two"}, root, map[string]string{
		"HERDR_WORKFLOWS_REPO_ROOT": root,
	}, "")
	if got.code != 0 {
		t.Fatalf("code = %d stderr = %q", got.code, got.stderr)
	}
	if !strings.Contains(got.stdout, "[1/1]") {
		t.Fatalf("stdout = %q", got.stdout)
	}
}

func TestRunRejectsInvalidInputValues(t *testing.T) {
	root := t.TempDir()
	writeWorkflow(t, root, "hi", "version: v1alpha1\nsteps:\n  - run: \"printf ok\"\n")

	got := runCLIEnv(t, []string{"run", "hi", "--input", "novalue"}, root, map[string]string{
		"HERDR_WORKFLOWS_REPO_ROOT": root,
	}, "")
	if got.code != 1 {
		t.Fatalf("code = %d", got.code)
	}
	if !strings.Contains(got.stderr, "invalid") {
		t.Fatalf("stderr = %q", got.stderr)
	}
	if !strings.Contains(got.stderr, "--input expects name=value") {
		t.Fatalf("stderr = %q", got.stderr)
	}
	if !strings.Contains(got.stderr, "novalue") {
		t.Fatalf("stderr = %q", got.stderr)
	}
}

func TestRunLaunchPayloadSeedsInputsAndInputOverrides(t *testing.T) {
	root := t.TempDir()
	writeWorkflow(t, root, "demo", strings.Join([]string{
		"version: v1alpha1",
		"inputs:",
		"  a: text",
		"steps:",
		`  - run: [sh, -c, 'test "$1" = "2"', sh, "{{inputs.a}}"]`,
		"",
	}, "\n"))

	got := runCLIEnv(t, []string{"run", "demo", "--launch-payload", "--input", "a=2"}, root, map[string]string{
		"HERDR_WORKFLOWS_REPO_ROOT": root,
	}, `{"name":"demo","inputs":{"a":"1"}}`)
	if got.code != 0 {
		t.Fatalf("code = %d stderr = %q", got.code, got.stderr)
	}
	if !strings.Contains(got.stdout, "[1/1]") {
		t.Fatalf("stdout = %q", got.stdout)
	}
}

func TestRunDetachedLaunchPayloadRejectsMissingDynamicDomainSnapshots(t *testing.T) {
	root := t.TempDir()
	script := filepath.Join(root, "discover.sh")
	if err := os.WriteFile(script, []byte("#!/bin/sh\necho main\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeWorkflow(t, root, "dyn", strings.Join([]string{
		"version: v1alpha1",
		"inputs:",
		"  branch:",
		"    type: choice",
		"    options:",
		"      run: [" + script + "]",
		"steps:",
		`  - run: [echo, "{{inputs.branch}}"]`,
		"",
	}, "\n"))

	got := runCLIEnv(t, []string{"run", "dyn", "--launch-payload"}, root, map[string]string{
		"HERDR_WORKFLOWS_REPO_ROOT": root,
	}, `{"name":"dyn","inputs":{"branch":"main"}}`)
	if got.code != 1 {
		t.Fatalf("code = %d stderr = %q", got.code, got.stderr)
	}
	if !strings.Contains(got.stderr, "missing launch payload domain snapshot") {
		t.Fatalf("stderr = %q", got.stderr)
	}
}

func TestRunRejectsHerdrProtocolBeforeMissingInputFailure(t *testing.T) {
	root := t.TempDir()
	writeWorkflow(t, root, "needs", strings.Join([]string{
		"version: v1alpha1",
		"inputs:",
		"  topic: text",
		"steps:",
		`  - run: [echo, "{{inputs.topic}}"]`,
		"",
	}, "\n"))

	withPingSocket(t, host.Protocol+1, host.MinHerdrVersion, func(socketPath string) {
		got := runCLIEnv(t, []string{"run", "needs"}, root, map[string]string{
			"HERDR_WORKFLOWS_REPO_ROOT": root,
			"HERDR_SOCKET_PATH":         socketPath,
		}, "")
		if got.code != 1 {
			t.Fatalf("code = %d stderr = %q", got.code, got.stderr)
		}
		if !strings.Contains(got.stderr, "herdr protocol mismatch") {
			t.Fatalf("stderr = %q", got.stderr)
		}
		if !strings.Contains(got.stderr, fmt.Sprintf("pinned=%d", host.Protocol)) {
			t.Fatalf("stderr = %q", got.stderr)
		}
		lower := strings.ToLower(got.stderr)
		for _, forbidden := range []string{"missing", "required input", "topic"} {
			if strings.Contains(lower, forbidden) {
				t.Fatalf("stderr = %q contains %q", got.stderr, forbidden)
			}
		}
	})
}

func TestRunRejectsHerdrVersionBelowManifestMinimum(t *testing.T) {
	root := t.TempDir()
	writeWorkflow(t, root, "hi", "version: v1alpha1\nsteps:\n  - run: \"printf ok\"\n")

	withPingSocket(t, host.Protocol, "0.7.4", func(socketPath string) {
		got := runCLIEnv(t, []string{"run", "hi"}, root, map[string]string{
			"HERDR_WORKFLOWS_REPO_ROOT": root,
			"HERDR_SOCKET_PATH":         socketPath,
		}, "")
		if got.code != 1 {
			t.Fatalf("code = %d stderr = %q", got.code, got.stderr)
		}
		if !strings.Contains(got.stderr, "herdr version too old") {
			t.Fatalf("stderr = %q", got.stderr)
		}
		if !strings.Contains(got.stderr, "installed=0.7.4") {
			t.Fatalf("stderr = %q", got.stderr)
		}
		if !strings.Contains(got.stderr, "required≥"+host.MinHerdrVersion) {
			t.Fatalf("stderr = %q", got.stderr)
		}
		if strings.Contains(got.stdout, "[1/1]") {
			t.Fatalf("stdout = %q", got.stdout)
		}
	})
}

type firstLineReader struct {
	r      io.Reader
	once   sync.Once
	closed bool
}

func (f *firstLineReader) Read(p []byte) (int, error) {
	if f.closed {
		return 0, io.EOF
	}
	n, err := f.r.Read(p)
	if n > 0 && bytes.Contains(p[:n], []byte("\n")) {
		f.once.Do(func() {
			f.closed = true
		})
	}
	if f.closed {
		return n, io.EOF
	}
	return n, err
}

func TestDetachedRunSurvivesClosedStdoutAfterFirstProgressLine(t *testing.T) {
	dir := t.TempDir()
	sentinel := filepath.Join(dir, "step-2-ran")
	writeWorkflow(t, dir, "epipe", fmt.Sprintf(`version: v1alpha1
title: Epipe
description: two blocking steps, so the reader can leave between them
steps:
  - run: ["sleep", "1"]
  - run: ["touch", %q]
`, sentinel))

	stdin := strings.NewReader(`{"name":"epipe","inputs":{}}`)
	pr, pw := io.Pipe()
	go func() {
		_, _ = io.Copy(io.Discard, &firstLineReader{r: pr})
		_ = pr.Close()
	}()

	env := map[string]string{
		"HOME":                      t.TempDir(),
		"HERDR_PLUGIN_CONFIG_DIR":   t.TempDir(),
		"HERDR_PLUGIN_STATE_DIR":    t.TempDir(),
		"HERDR_WORKFLOWS_REPO_ROOT": dir,
	}
	var stderr bytes.Buffer
	code := withEnv(env, func() int {
		prev, err := os.Getwd()
		if err != nil {
			t.Fatal(err)
		}
		if err := os.Chdir(dir); err != nil {
			t.Fatal(err)
		}
		defer func() { _ = os.Chdir(prev) }()
		return Main([]string{"run", "epipe", "--launch-payload"}, stdin, pw, &stderr)
	})
	_ = pw.Close()

	if code != 0 {
		t.Fatalf("code = %d stderr = %q", code, stderr.String())
	}
	if _, err := os.Stat(sentinel); err != nil {
		t.Fatalf("sentinel missing: %v stderr = %q", err, stderr.String())
	}
}

func TestLaunchPayloadRejectsOversizedStdin(t *testing.T) {
	root := t.TempDir()
	huge := strings.Repeat("x", caps.CaptureByteLimit+1)
	got := runCLIEnv(t, []string{"run", "demo", "--launch-payload"}, root, nil, huge)
	if got.code == 0 {
		t.Fatalf("exit 0, stderr=%q", got.stderr)
	}
	if !strings.Contains(got.stderr, "launch payload") || !strings.Contains(got.stderr, "byte limit") {
		t.Fatalf("stderr=%q want launch payload capture limit", got.stderr)
	}
}
