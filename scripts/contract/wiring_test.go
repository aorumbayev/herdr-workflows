package contract_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func shouldSkipDir(name string) bool {
	switch name {
	case ".git", "node_modules":
		return true
	default:
		return false
	}
}

func readRepoFile(t *testing.T, rel string) string {
	t.Helper()
	root := repoRoot(t)
	data, err := os.ReadFile(filepath.Join(root, rel))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestVerifyWorkflowUsesUnifiedGoToolVerify(t *testing.T) {
	text := readRepoFile(t, filepath.Join(".github", "workflows", "verify.yml"))
	for _, want := range []string{
		"run: go tool verify\n",
		`go-version: "1.27`,
		"ubuntu-latest",
		"macos-latest",
		"actions/setup-node@",
		"golangci/golangci-lint-action@",
		"version: v2.13",
		"install-only: true",
		"install-mode: goinstall",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf(".github/workflows/verify.yml missing %q", want)
		}
	}
}

func TestGoModDeclaresVerifyTool(t *testing.T) {
	text := readRepoFile(t, "go.mod")
	for _, want := range []string{
		"github.com/aorumbayev/herdr-workflows/scripts/verify",
		"golang.org/x/vuln/cmd/govulncheck",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("go.mod missing %q", want)
		}
	}
}

func TestGoModHasNoEsbuild(t *testing.T) {
	text := readRepoFile(t, "go.mod")
	needle := "github.com/evanw/" + "esbuild"
	if strings.Contains(text, needle) {
		t.Fatalf("go.mod must not require %s", needle)
	}
}

func TestPluginSourceHasNoRuntimeTypeScriptTransform(t *testing.T) {
	root := repoRoot(t)
	// Concatenate these strings so that this test file does not contain the forbidden literals.
	forbidden := []string{
		"api." + "Transform",
		"Loader" + "TS",
		"github.com/evanw/" + "esbuild",
		"oven-sh/" + "setup-bun",
	}
	var violations []string
	for _, dir := range []string{"internal", "scripts"} {
		err := filepath.WalkDir(filepath.Join(root, dir), func(path string, d os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() {
				if shouldSkipDir(d.Name()) {
					return filepath.SkipDir
				}
				return nil
			}
			if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			data, readErr := os.ReadFile(path)
			if readErr != nil {
				return readErr
			}
			text := string(data)
			rel, relErr := filepath.Rel(root, path)
			if relErr != nil {
				rel = path
			} else {
				rel = filepath.ToSlash(rel)
			}
			for _, phrase := range forbidden {
				if strings.Contains(text, phrase) {
					violations = append(violations, rel+": "+phrase)
				}
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	if len(violations) > 0 {
		t.Fatalf("plugin source must not use runtime TypeScript transform or Bun setup:\n%s", strings.Join(violations, "\n"))
	}
}

func TestPreCommitUsesGoToolVerifyFast(t *testing.T) {
	text := readRepoFile(t, filepath.Join(".githooks", "pre-commit"))
	if !strings.Contains(text, "go tool verify -fast") {
		t.Fatal(`.githooks/pre-commit missing "go tool verify -fast"`)
	}
}

func TestReleaseAndDocsWorkflowsUseGo127(t *testing.T) {
	for _, rel := range []string{
		filepath.Join(".github", "workflows", "release.yml"),
		filepath.Join(".github", "workflows", "docs.yml"),
	} {
		text := readRepoFile(t, rel)
		if !strings.Contains(text, `go-version: "1.27`) {
			t.Fatalf("%s missing go-version 1.27", rel)
		}
	}
}

func TestContributingDocumentsUnifiedVerify(t *testing.T) {
	text := readRepoFile(t, "CONTRIBUTING.md")
	if !strings.Contains(text, "**1.27**") {
		t.Fatal(`CONTRIBUTING.md must require Go **1.27** or newer`)
	}
	for _, rel := range []string{"CONTRIBUTING.md", "AGENTS.md", "CLAUDE.md"} {
		assertDocumentsUnifiedVerify(t, rel)
	}
}

func assertDocumentsUnifiedVerify(t *testing.T, rel string) {
	t.Helper()
	text := readRepoFile(t, rel)
	for _, want := range []string{
		"go tool verify",
		"go tool verify -fast",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("%s missing %q", rel, want)
		}
	}
}

func TestPromptfooExampleUsesClaudeAgentSDK(t *testing.T) {
	text := readRepoFile(t, filepath.Join(".agents", "skills", "promptfoo-skill-eval", "promptfooconfig.example.yaml"))
	if !strings.Contains(text, "anthropic:claude-agent-sdk") {
		t.Fatal("promptfooconfig.example.yaml must use anthropic:claude-agent-sdk")
	}
	if !strings.Contains(text, "skill-used") || !strings.Contains(text, "not-skill-used") {
		t.Fatal("promptfooconfig.example.yaml must use built-in skill assertions")
	}
}

func TestAgentsCiteVerifyProseGoCommand(t *testing.T) {
	for _, rel := range []string{"AGENTS.md", "CLAUDE.md"} {
		text := readRepoFile(t, rel)
		if !strings.Contains(text, "go run ./scripts/verify-prose") {
			t.Fatalf("%s missing %q", rel, "go run ./scripts/verify-prose")
		}
	}
}
