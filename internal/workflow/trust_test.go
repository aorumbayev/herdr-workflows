package workflow

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const trustVersion = "version: v1alpha1\n"

func writeWorkflow(t *testing.T, root, name, body string) {
	t.Helper()
	dir := filepath.Join(root, ".hwf", "workflows")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name+".yaml"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func readWorkflow(t *testing.T, root, name string) Document {
	t.Helper()
	file := filepath.Join(root, ".hwf", "workflows", name+".yaml")
	body, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	return mustParse(t, string(body))
}

func TestAnalyzeResolvedSensitivity(t *testing.T) {
	t.Run("command child", func(t *testing.T) {
		root := t.TempDir()
		writeWorkflow(t, root, "child", trustVersion+"steps:\n  - run: [echo, hi]\n")
		writeWorkflow(t, root, "parent", trustVersion+"steps:\n  - workflow: child\n")
		parent := readWorkflow(t, root, "parent")
		flags := AnalyzeResolvedSensitivity(parent, "parent", root)
		if !flags.HasCommands || !strings.Contains(strings.Join(SensitivityLabels(flags), ","), "commands") {
			t.Fatalf("unexpected flags: %#v", flags)
		}
		if analyzeWorkflowSensitivity(parent).HasCommands {
			t.Fatal("raw parent should not inherit child commands")
		}
	})

	t.Run("transcript child", func(t *testing.T) {
		root := t.TempDir()
		writeWorkflow(t, root, "child", trustVersion+"steps:\n  - agent: 'see {{context.transcript}}'\n    using: claude\n")
		writeWorkflow(t, root, "parent", trustVersion+"steps:\n  - workflow: child\n")
		flags := AnalyzeResolvedSensitivity(readWorkflow(t, root, "parent"), "parent", root)
		if !flags.HasTranscript {
			t.Fatalf("transcript flag missing: %#v", flags)
		}
	})

	t.Run("unresolved child", func(t *testing.T) {
		root := t.TempDir()
		writeWorkflow(t, root, "parent", trustVersion+"steps:\n  - workflow: missing-child\n")
		flags := AnalyzeResolvedSensitivity(readWorkflow(t, root, "parent"), "parent", root)
		if len(flags.UnresolvedChildren) != 1 || flags.UnresolvedChildren[0] != "missing-child" {
			t.Fatalf("unexpected unresolved children: %#v", flags.UnresolvedChildren)
		}
	})

	t.Run("cycle remains finite", func(t *testing.T) {
		root := t.TempDir()
		writeWorkflow(t, root, "a", trustVersion+"steps:\n  - workflow: b\n  - run: [echo, a]\n")
		writeWorkflow(t, root, "b", trustVersion+"steps:\n  - workflow: a\n")
		flags := AnalyzeResolvedSensitivity(readWorkflow(t, root, "a"), "a", root)
		if !flags.HasCommands {
			t.Fatalf("cycle hid reachable command: %#v", flags)
		}
	})

	t.Run("sensitive method", func(t *testing.T) {
		raw := mustParse(t, trustVersion+"steps:\n  - herdr: pane.close\n    params: {pane_id: 'w1:p1'}\n")
		flags := analyzeWorkflowSensitivity(raw)
		if !slicesEqual(flags.SensitiveMethods, []string{"pane.close"}) {
			t.Fatalf("unexpected methods: %#v", flags.SensitiveMethods)
		}
	})
}

func slicesEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestWorkflowTrustHelpers(t *testing.T) {
	if got := HumanizeWorkflowName("ship-fast_now"); got != "Ship Fast Now" {
		t.Fatalf("humanized name = %q", got)
	}
	if got := DisplayTitle("ship-fast", "  "); got != "Ship Fast" {
		t.Fatalf("display title = %q", got)
	}
	flags := Sensitivity{HasCommands: true, HasTranscript: true, SensitiveMethods: []string{"pane.close"}, UnresolvedChildren: []string{"missing"}}
	if got := FormatSensitivityBanner(flags, "warning"); got != "⚠ warning: commands · transcript · herdr:pane.close · unresolved:missing\n" {
		t.Fatalf("banner = %q", got)
	}
	if got := FormatSensitivityBanner(Sensitivity{}, ""); got != "" {
		t.Fatalf("empty banner = %q", got)
	}
}

func TestHomeRepoRootKeepsGlobalSource(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("HERDR_PLUGIN_CONFIG_DIR", filepath.Join(home, "plugin-config"))
	writeWorkflow(t, home, "pipeline", trustVersion+"steps:\n  - run: [echo, hi]\n")

	resolved, err := ResolveWorkflowFile("pipeline", home)
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Source != "global" {
		t.Fatalf("source = %q, want global", resolved.Source)
	}

	entries, err := ListWorkflows(home)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %d, want 1", len(entries))
	}
	if entries[0].Source != "global" || entries[0].RepoOwned {
		t.Fatalf("entry = %+v, want global and not repo-owned", entries[0])
	}
}
