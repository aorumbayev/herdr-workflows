package cli

import (
	"os"
	"strings"
	"testing"
)

func TestScratchCommandsRoundTripWithoutHerdr(t *testing.T) {
	root := t.TempDir()
	state := t.TempDir()
	if err := os.Chmod(state, 0o700); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"HERDR_PLUGIN_STATE_DIR": state}
	set := runCLI([]string{"scratch", "set", "triage.last_pr", "42"}, root, env, "")
	if set.code != 0 {
		t.Fatalf("set code=%d stderr=%q", set.code, set.stderr)
	}
	get := runCLI([]string{"scratch", "get", "triage.last_pr"}, root, env, "")
	if get.code != 0 || strings.TrimSpace(get.stdout) != "42" {
		t.Fatalf("get code=%d stdout=%q stderr=%q", get.code, get.stdout, get.stderr)
	}
	list := runCLI([]string{"scratch", "list"}, root, env, "")
	if list.code != 0 || strings.TrimSpace(list.stdout) != "triage.last_pr" {
		t.Fatalf("list code=%d stdout=%q stderr=%q", list.code, list.stdout, list.stderr)
	}
	del := runCLI([]string{"scratch", "delete", "triage.last_pr"}, root, env, "")
	if del.code != 0 {
		t.Fatalf("delete code=%d stderr=%q", del.code, del.stderr)
	}
	missing := runCLI([]string{"scratch", "get", "triage.last_pr"}, root, env, "")
	if missing.code == 0 {
		t.Fatal("get after delete succeeded")
	}
}
