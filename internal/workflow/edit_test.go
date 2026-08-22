package workflow_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

func TestResolveEditorPrefersEDITORThenVISUAL(t *testing.T) {
	got, err := workflow.ResolveEditor(func(key string) string {
		switch key {
		case "EDITOR":
			return "ed"
		case "VISUAL":
			return "vi"
		default:
			return ""
		}
	})
	if err != nil || got != "ed" {
		t.Fatalf("got %q err=%v", got, err)
	}
	got, err = workflow.ResolveEditor(func(key string) string {
		if key == "VISUAL" {
			return "vim"
		}
		return ""
	})
	if err != nil || got != "vim" {
		t.Fatalf("visual got %q err=%v", got, err)
	}
	_, err = workflow.ResolveEditor(func(string) string { return "" })
	if err == nil || !strings.Contains(err.Error(), "EDITOR") {
		t.Fatalf("err = %v", err)
	}
}

func TestEditAndValidateRunsEditorThenLoader(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, ".hwf", "workflows", "demo.yaml")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("version: v1alpha1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	editor := filepath.Join(t.TempDir(), "fake-editor")
	script := "#!/bin/sh\nprintf '%s\\n' 'version: v1alpha1' 'steps:' '  - run: [echo, hi]' > \"$1\"\n"
	if err := os.WriteFile(editor, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	result := workflow.EditAndValidate(workflow.EditOpts{
		Path:     path,
		Name:     "demo",
		RepoRoot: root,
		Getenv: func(key string) string {
			if key == "EDITOR" {
				return editor
			}
			return ""
		},
	})
	if !result.OK {
		t.Fatalf("result = %+v", result)
	}
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "run: [echo, hi]") {
		t.Fatalf("body = %q", body)
	}
}

func TestEditAndValidateReportsLoaderErrorAfterEditor(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "broken.yaml")
	if err := os.WriteFile(path, []byte("version: v1alpha1\nsteps:\n  - run: [echo, hi]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	editor := filepath.Join(t.TempDir(), "fake-editor")
	script := "#!/bin/sh\nprintf '%s\\n' 'version: v1alpha1' > \"$1\"\n"
	if err := os.WriteFile(editor, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	result := workflow.EditAndValidate(workflow.EditOpts{
		Path:     path,
		Name:     "broken",
		RepoRoot: root,
		Getenv:   func(key string) string { return map[string]string{"EDITOR": editor}[key] },
	})
	if result.OK || !strings.Contains(strings.ToLower(result.Error), "steps") {
		t.Fatalf("result = %+v", result)
	}
}

func TestCreateRepoWorkflowWritesStub(t *testing.T) {
	root := t.TempDir()
	path, err := workflow.CreateRepoWorkflow(root, "ship-it")
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(root, ".hwf", "workflows", "ship-it.yaml")
	if path != want {
		t.Fatalf("path = %q want %q", path, want)
	}
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(body)
	if !strings.HasPrefix(text, workflow.SchemaPointer()+"\n") {
		t.Fatalf("missing schema pointer: %q", text)
	}
	if !strings.Contains(text, "version: v1alpha1") || !strings.Contains(text, "steps:") {
		t.Fatalf("stub = %q", text)
	}
	result := workflow.ValidateFile(path, "ship-it", root)
	if !result.OK {
		t.Fatalf("stub must load: %+v", result)
	}
}

func TestCreateRepoWorkflowRejectsBadNameAndConflict(t *testing.T) {
	root := t.TempDir()
	if _, err := workflow.CreateRepoWorkflow(root, "Bad Name"); err == nil {
		t.Fatal("expected name error")
	}
	if _, err := workflow.CreateRepoWorkflow(root, "ok"); err != nil {
		t.Fatal(err)
	}
	if _, err := workflow.CreateRepoWorkflow(root, "ok"); err == nil {
		t.Fatal("expected conflict")
	}
}

func TestEditAndValidateUsesInjectableRunner(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "x.yaml")
	if err := os.WriteFile(path, []byte("version: v1alpha1\nsteps:\n  - run: [echo, hi]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	var argv []string
	result := workflow.EditAndValidate(workflow.EditOpts{
		Path:     path,
		Name:     "x",
		RepoRoot: root,
		Getenv:   func(string) string { return "my-editor" },
		Run: func(args []string) error {
			argv = append([]string(nil), args...)
			return nil
		},
	})
	if !result.OK {
		t.Fatalf("result = %+v", result)
	}
	if len(argv) != 2 || argv[0] != "my-editor" || argv[1] != path {
		t.Fatalf("argv = %#v", argv)
	}
}

func TestEditAndValidatePropagatesEditorFailure(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "x.yaml")
	if err := os.WriteFile(path, []byte("version: v1alpha1\nsteps:\n  - run: [echo, hi]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	result := workflow.EditAndValidate(workflow.EditOpts{
		Path:     path,
		Name:     "x",
		RepoRoot: root,
		Getenv:   func(string) string { return "ed" },
		Run: func([]string) error {
			return errEditorFailed
		},
	})
	if result.OK || result.Error != errEditorFailed.Error() {
		t.Fatalf("result = %+v", result)
	}
}

var errEditorFailed = errString("editor failed")

type errString string

func (e errString) Error() string { return string(e) }
