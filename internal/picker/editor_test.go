package picker

import (
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

func TestEditorCommandSplitsEDITORFlags(t *testing.T) {
	cmd := editorCommand("code --wait", "/tmp/config.yaml")
	want := []string{"code", "--wait", "/tmp/config.yaml"}
	if strings.Join(cmd.Args, " ") != strings.Join(want, " ") {
		t.Fatalf("Args = %#v, want %#v", cmd.Args, want)
	}
}

func TestOpenEditorDoesNotRunInsideUpdate(t *testing.T) {
	root := t.TempDir()
	path := root + "/deploy.yaml"
	if err := os.WriteFile(path, []byte("version: v1alpha1\nsteps:\n  - run: [echo, hi]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	var ran bool
	m := New(Options{
		Entries: []workflow.ListEntry{
			{Name: "deploy", Source: "repo", File: path, Title: "Deploy"},
		},
		Width:    80,
		RepoRoot: root,
		EditWorkflow: func(string, string) workflow.ValidateResult {
			ran = true
			return workflow.ValidateResult{OK: true}
		},
	})
	m = apply(m, "ctrl+p")
	next, cmd := m.Update(press("o"))
	m = next.(Model)
	if ran {
		t.Fatal("editor hook must not run inside Update")
	}
	if m.mode != modeEditPlace {
		t.Fatalf("mode = %v, want edit place", m.mode)
	}
	if cmd != nil {
		t.Fatal("chooser must not start the editor")
	}
	next, cmd = m.Update(press("enter"))
	m = next.(Model)
	if ran {
		t.Fatal("editor hook must not run inside Update")
	}
	if m.status != "" {
		t.Fatalf("status set inside Update: %q", m.status)
	}
	if cmd == nil {
		t.Fatal("popup confirm must return an editor cmd")
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
		Entries: []workflow.ListEntry{
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
	m = apply(m, "ctrl+p")
	next, _ := m.Update(press("o"))
	m = next.(Model)
	if m.mode != modeEditPlace {
		t.Fatalf("mode = %v, want edit place", m.mode)
	}
	next, cmd := m.Update(press("enter"))
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

func TestEditPlacementTabQuitsWithoutReopen(t *testing.T) {
	var opened []string
	m := New(Options{
		Entries: []workflow.ListEntry{
			{Name: "deploy", Source: "repo", File: "/r/deploy.yaml", Title: "Deploy"},
		},
		Width: 80,
		OpenEditor: func(path, name, placement string) error {
			opened = append(opened, path+"|"+name+"|"+placement)
			return nil
		},
		ReopenPopup: func(PopupState) error {
			t.Fatal("external editor must not reopen the picker")
			return nil
		},
	})
	m = apply(m, "ctrl+p", "o")
	for m.editPlaceCursor < 3 {
		m = apply(m, "down")
	}
	m = apply(m, "enter")
	if !m.quit {
		t.Fatal("tab editor must quit the picker")
	}
	if len(opened) != 1 || opened[0] != "/r/deploy.yaml|deploy|tab" {
		t.Fatalf("opened = %v", opened)
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
	m = apply(m, "ctrl+p", "n", "down", "enter", "s", "h", "i", "p", "enter", "enter")
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

func TestPopupEditExpandsThenRespawnsCompact(t *testing.T) {
	var states []PopupState
	m := New(Options{
		Entries: []workflow.ListEntry{
			{Name: "deploy", Source: "repo", File: "/r/deploy.yaml", Title: "Deploy"},
		},
		Width: 80,
		EditWorkflow: func(string, string) workflow.ValidateResult {
			t.Fatal("compact popup must not run the editor")
			return workflow.ValidateResult{}
		},
		ReopenPopup: func(state PopupState) error {
			states = append(states, state)
			return nil
		},
	})
	m = apply(m, "ctrl+p", "o", "enter")
	if !m.quit {
		t.Fatal("popup edit must quit the compact popup")
	}
	if len(states) != 1 {
		t.Fatalf("states = %v", states)
	}
	if states[0].Width != expandedWidth || states[0].Height != expandedHeight {
		t.Fatalf("edit popup opens expanded: %+v", states[0])
	}
	if states[0].EditFile != "/r/deploy.yaml" || states[0].EditName != "deploy" {
		t.Fatalf("edit target lost: %+v", states[0])
	}

	var edited string
	var back []PopupState
	restored := New(Options{
		Entries: []workflow.ListEntry{
			{Name: "deploy", Source: "repo", File: "/r/deploy.yaml", Title: "Deploy"},
		},
		Width:   80,
		Restore: &states[0],
		EditWorkflow: func(path, _ string) workflow.ValidateResult {
			edited = path
			return workflow.ValidateResult{OK: true}
		},
		ReopenPopup: func(state PopupState) error {
			back = append(back, state)
			return nil
		},
	})
	restored = runCmd(restored, restored.Init())
	if edited != "/r/deploy.yaml" {
		t.Fatalf("restored popup did not edit: %q", edited)
	}
	if len(back) != 1 {
		t.Fatalf("validated edit must respawn compact, got %v", back)
	}
	if back[0].Width != compactWidth || back[0].Height != compactHeight {
		t.Fatalf("respawn geometry = %+v", back[0])
	}
	if back[0].EditFile != "" {
		t.Fatalf("respawn must not repeat the edit: %+v", back[0])
	}
	if !restored.quit {
		t.Fatal("restored popup must quit into the compact respawn")
	}
}
