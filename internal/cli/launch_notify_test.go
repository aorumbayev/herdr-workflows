package cli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

const outcomeNotifyPrefix = "notification show " + launchNotifyTitle + " "

// recordingHerdr writes every argument list it receives, one call per line.
func recordingHerdr(t *testing.T) (bin, log string) {
	t.Helper()
	dir := t.TempDir()
	bin = filepath.Join(dir, "fake-herdr")
	log = filepath.Join(dir, "calls.log")
	script := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> " + log + "\nexit 0\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return bin, log
}

func notificationCall(t *testing.T, log string) string {
	t.Helper()
	body, err := os.ReadFile(log)
	if err != nil {
		if os.IsNotExist(err) {
			return ""
		}
		t.Fatal(err)
	}
	for _, line := range strings.Split(string(body), "\n") {
		if strings.HasPrefix(line, outcomeNotifyPrefix) {
			return line
		}
	}
	return ""
}

func runDetached(t *testing.T, args []string, root, name, body string) (cliResult, string) {
	t.Helper()
	writeWorkflow(t, root, name, body)
	bin, log := recordingHerdr(t)
	got := runCLIEnv(t, args, root, map[string]string{
		"HERDR_WORKFLOWS_REPO_ROOT": root,
		"HERDR_BIN_PATH":            bin,
	}, "")
	return got, log
}

func TestDetachedRunNotifiesSuccessWithDoneSound(t *testing.T) {
	root := t.TempDir()
	got, log := runDetached(t, []string{"run", "winner"}, root, "winner",
		"version: v1alpha1\ntitle: Winner\nsteps:\n  - run: [\"true\"]\n")
	if got.code != 0 {
		t.Fatalf("code = %d stderr = %q", got.code, got.stderr)
	}
	call := notificationCall(t, log)
	if !strings.HasPrefix(call, outcomeNotifyPrefix+"--body Winner succeeded in ") {
		t.Fatalf("success notification = %q", call)
	}
	if !strings.HasSuffix(call, " --sound done") {
		t.Fatalf("success notification must use the done sound: %q", call)
	}
}

func TestDetachedRunNotifiesFailureWithRunIDAndNoSound(t *testing.T) {
	root := t.TempDir()
	got, log := runDetached(t, []string{"run", "loser"}, root, "loser",
		"version: v1alpha1\ntitle: Loser\nsteps:\n  - run: [\"false\"]\n")
	if got.code == 0 {
		t.Fatalf("a failing workflow must exit non-zero, stdout = %q", got.stdout)
	}
	call := notificationCall(t, log)
	if !strings.HasPrefix(call, outcomeNotifyPrefix+"--body Loser failed after ") {
		t.Fatalf("failure notification = %q", call)
	}
	if !strings.HasSuffix(call, " --sound none") {
		t.Fatalf("failure notification must be silent: %q", call)
	}
	id, _, _ := strings.Cut(call[strings.LastIndex(call, " - ")+3:], " ")
	if len(id) != 8 {
		t.Fatalf("failure notification must name the run id: %q", call)
	}
}

func TestLaunchPayloadRunNotifiesTheSameWay(t *testing.T) {
	root := t.TempDir()
	writeWorkflow(t, root, "payload", "version: v1alpha1\ntitle: Payload\nsteps:\n  - run: [\"true\"]\n")
	bin, log := recordingHerdr(t)
	got := runCLIEnv(t, []string{"run", "payload", "--launch-payload"}, root, map[string]string{
		"HERDR_WORKFLOWS_REPO_ROOT": root,
		"HERDR_BIN_PATH":            bin,
	}, `{"name":"payload","inputs":{}}`)
	if got.code != 0 {
		t.Fatalf("code = %d stderr = %q", got.code, got.stderr)
	}
	if call := notificationCall(t, log); !strings.Contains(call, "Payload succeeded in ") {
		t.Fatalf("a picker launch must notify too: %q", call)
	}
}

func TestInteractiveRunEmitsNoNotification(t *testing.T) {
	prev := isTerminalFile
	isTerminalFile = func(*os.File) bool { return true }
	t.Cleanup(func() { isTerminalFile = prev })

	root := t.TempDir()
	writeWorkflow(t, root, "quiet", "version: v1alpha1\ntitle: Quiet\nsteps:\n  - run: [\"true\"]\n")
	bin, log := recordingHerdr(t)
	out, err := os.CreateTemp(t.TempDir(), "stdout")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = out.Close() })

	code := withEnv(map[string]string{
		"HOME":                      t.TempDir(),
		"HERDR_PLUGIN_CONFIG_DIR":   t.TempDir(),
		"HERDR_PLUGIN_STATE_DIR":    t.TempDir(),
		"HERDR_WORKFLOWS_REPO_ROOT": root,
		"HERDR_BIN_PATH":            bin,
	}, func() int {
		return Main([]string{"run", "quiet"}, strings.NewReader(""), out, os.Stderr)
	})
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	if call := notificationCall(t, log); call != "" {
		t.Fatalf("an interactive run must stay silent, got %q", call)
	}
}

func TestRunIsDetachedFollowsTheOutputFile(t *testing.T) {
	cmd := &cobra.Command{}
	cmd.SetOut(&strings.Builder{})
	if !runIsDetached(cmd) {
		t.Fatal("output that is not a file must count as detached")
	}
	file, err := os.CreateTemp(t.TempDir(), "out")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = file.Close() })
	cmd.SetOut(file)
	if !runIsDetached(cmd) {
		t.Fatal("a redirected file must count as detached")
	}
	prev := isTerminalFile
	isTerminalFile = func(*os.File) bool { return true }
	t.Cleanup(func() { isTerminalFile = prev })
	if runIsDetached(cmd) {
		t.Fatal("a terminal must not count as detached")
	}
}
