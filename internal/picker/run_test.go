package picker

import (
	"strings"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

func TestBeginLaunchListenCmdDeliversAck(t *testing.T) {
	entry := workflow.ListEntry{Name: "plain", Source: "repo", File: "/r/plain.yaml", Title: "Plain"}
	events := make(chan LaunchEvent, 1)
	m := New(Options{
		Entries:  []workflow.ListEntry{entry},
		Width:    80,
		RepoRoot: t.TempDir(),
		LoadWorkflow: func(e workflow.ListEntry) (*workflow.Definition, error) {
			return &workflow.Definition{
				Name: e.Name, File: e.File, Version: workflow.Format, Title: "Plain",
				Steps: []workflow.Step{{Action: workflow.RunAction{Payload: workflow.RunPayload{Argv: []string{"true"}}}}},
			}, nil
		},
		LaunchRun: func(LaunchRunOpts) LaunchRunHandle {
			return LaunchRunHandle{Detach: func() {}, Events: events}
		},
		AllocateRunID: func() string { return "550e8400-e29b-41d4-a716-446655440010" },
	})
	next, cmd := m.Update(press("enter"))
	m = next.(Model)
	if cmd == nil {
		t.Fatal("beginLaunch must return a listen cmd when LaunchRunHandle exposes Events")
	}
	if !strings.Contains(m.View().Content, "STARTING") {
		t.Fatalf("expected STARTING:\n%s", m.View().Content)
	}

	events <- LaunchEvent{Ack: "@hwf-history:claimed 550e8400-e29b-41d4-a716-446655440010"}
	next, _ = m.Update(cmd())
	m = next.(Model)
	if !m.quit {
		t.Fatal("the listen cmd ack must reach Update and close the popup")
	}
}

func TestPrepareWiresHooksFromOptions(t *testing.T) {
	entry := workflow.ListEntry{Name: "plain", Source: "repo", File: "/r/plain.yaml", Title: "Plain"}
	var (
		edited   []string
		opened   string
		notified []string
		launched LaunchRunOpts
		exported string
	)
	root := t.TempDir()
	m, err := Prepare(Options{
		Entries:  []workflow.ListEntry{entry},
		RepoRoot: root,
		LoadWorkflow: func(e workflow.ListEntry) (*workflow.Definition, error) {
			return &workflow.Definition{
				Name: e.Name, File: e.File, Version: workflow.Format, Title: "Plain",
				Steps: []workflow.Step{{Action: workflow.RunAction{Payload: workflow.RunPayload{Argv: []string{"true"}}}}},
			}, nil
		},
		EditWorkflow: func(path, name string) workflow.ValidateResult {
			edited = append(edited, name)
			return workflow.ValidateResult{OK: true}
		},
		OpenURL: func(url string) error { opened = url; return nil },
		Notify: func(title string, body ...string) error {
			notified = append(notified, title+"|"+strings.Join(body, " "))
			return nil
		},
		LaunchRun: func(opts LaunchRunOpts) LaunchRunHandle {
			launched = opts
			return LaunchRunHandle{Detach: func() {}}
		},
		AllocateRunID: func() string { return "550e8400-e29b-41d4-a716-446655440099" },
		ExportShare: func(e workflow.ListEntry) (string, error) {
			exported = "hwf workflow import \"bundle-" + e.Name + "\""
			return exported, nil
		},
		CopyClipboard: func(string) error { return nil },
		Chdir:         func(string) error { return nil },
		Env:           func(string) string { return "" },
	})
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}

	_ = apply(m, "ctrl+p", "n", "down", "enter", "x", "enter", "enter", "enter")
	if len(edited) != 1 || edited[0] != "x" {
		t.Fatalf("EditWorkflow = %v (Options hooks not passed)", edited)
	}

	m, err = Prepare(Options{
		Entries:  []workflow.ListEntry{entry},
		RepoRoot: root,
		OpenURL:  func(url string) error { opened = url; return nil },
		Chdir:    func(string) error { return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	opened = ""
	_ = apply(m, "ctrl+p", "e")
	if opened == "" {
		t.Fatal("OpenURL not wired from Options")
	}

	m, err = Prepare(Options{
		Entries:  []workflow.ListEntry{entry},
		RepoRoot: root,
		LoadWorkflow: func(e workflow.ListEntry) (*workflow.Definition, error) {
			return &workflow.Definition{
				Name: e.Name, File: e.File, Version: workflow.Format, Title: "Plain",
				Steps: []workflow.Step{{Action: workflow.RunAction{Payload: workflow.RunPayload{Argv: []string{"true"}}}}},
			}, nil
		},
		LaunchRun: func(opts LaunchRunOpts) LaunchRunHandle {
			launched = opts
			return LaunchRunHandle{Detach: func() {}}
		},
		AllocateRunID: func() string { return "550e8400-e29b-41d4-a716-446655440099" },
		Chdir:         func(string) error { return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	launched = LaunchRunOpts{}
	m = apply(m, "enter")
	if launched.RunID != "550e8400-e29b-41d4-a716-446655440099" {
		t.Fatalf("LaunchRun not wired from Options: %#v", launched)
	}
	if !strings.Contains(m.View().Content, "STARTING") {
		t.Fatalf("expected STARTING after wired launch:\n%s", m.View().Content)
	}

	m, err = Prepare(Options{
		Entries:       []workflow.ListEntry{entry},
		RepoRoot:      root,
		Notify:        func(title string, body ...string) error { notified = append(notified, title); return nil },
		ExportShare:   func(e workflow.ListEntry) (string, error) { return "hwf workflow import \"x\"", nil },
		CopyClipboard: func(string) error { return nil },
		Chdir:         func(string) error { return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	notified = nil
	_ = apply(m, "ctrl+p", "s")
	if len(notified) == 0 {
		t.Fatal("ExportShare/Notify not wired from Options")
	}
}
