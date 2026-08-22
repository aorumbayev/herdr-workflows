package picker

import (
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

func TestOpenEditorDoesNotRunInsideUpdate(t *testing.T) {
	root := t.TempDir()
	path := root + "/deploy.yaml"
	if err := os.WriteFile(path, []byte("version: v1alpha1\nsteps:\n  - run: [echo, hi]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	var ran bool
	m := New(Options{
		Entries: []workflow.WorkflowListEntry{
			{Name: "deploy", Source: "repo", File: path, Title: "Deploy"},
		},
		Width:    80,
		RepoRoot: root,
		EditWorkflow: func(string, string) workflow.ValidateResult {
			ran = true
			return workflow.ValidateResult{OK: true}
		},
	})
	m = apply(m, "ctrl+k")
	next, cmd := m.Update(press("o"))
	m = next.(Model)
	if ran {
		t.Fatal("editor hook must not run inside Update")
	}
	if m.status != "" {
		t.Fatalf("status set inside Update: %q", m.status)
	}
	if cmd == nil {
		t.Fatal("open must return an editor cmd")
	}
	m = runCmd(m, cmd)
	if !ran {
		t.Fatal("editor hook must run from the returned cmd")
	}
	if m.quit || m.mode != modeList {
		t.Fatalf("open must stay on list, quit=%v mode=%v", m.quit, m.mode)
	}
	if !strings.Contains(m.status, "validated deploy") {
		t.Fatalf("status = %q", m.status)
	}
}

func TestLiveOpenEditorReturnsExecProcess(t *testing.T) {
	m := New(Options{
		Entries: []workflow.WorkflowListEntry{
			{Name: "deploy", Source: "repo", File: "/r/deploy.yaml", Title: "Deploy"},
		},
		Width: 80,
		Env: func(key string) string {
			if key == "EDITOR" {
				return "true"
			}
			return ""
		},
	})
	m = apply(m, "ctrl+k")
	next, cmd := m.Update(press("o"))
	m = next.(Model)
	if m.status != "" {
		t.Fatalf("status set inside Update: %q", m.status)
	}
	if cmd == nil {
		t.Fatal("live open must return tea.ExecProcess")
	}
	msg := cmd()
	if fmt.Sprintf("%T", msg) != "tea.execMsg" {
		t.Fatalf("live editor cmd type = %T want tea.execMsg", msg)
	}
}

func TestNewNameEditorDoesNotRunInsideUpdate(t *testing.T) {
	root := t.TempDir()
	var ran bool
	m := New(Options{
		Width:    80,
		RepoRoot: root,
		EditWorkflow: func(string, string) workflow.ValidateResult {
			ran = true
			return workflow.ValidateResult{OK: true}
		},
	})
	m = apply(m, "ctrl+k", "n", "s", "h", "i", "p")
	next, cmd := m.Update(press("enter"))
	m = next.(Model)
	if ran {
		t.Fatal("editor hook must not run inside Update")
	}
	if m.mode != modeList {
		t.Fatalf("create must return to list, mode=%v", m.mode)
	}
	m = runCmd(m, cmd)
	if !ran {
		t.Fatal("editor hook must run from the returned cmd")
	}
	if m.quit {
		t.Fatal("new must keep the picker open")
	}
	if !strings.Contains(m.status, "validated ship") {
		t.Fatalf("status = %q", m.status)
	}
}
