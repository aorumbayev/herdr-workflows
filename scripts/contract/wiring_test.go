package contract_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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
	for _, forbidden := range []string{
		"setup-bun",
		"bun test",
		"npm run verify",
		"bun install",
		"go-test:",
		"go-lint:",
		"go-verify:",
		"go test -race ./...",
		"go run ./scripts/verify-prose",
		"go run ./scripts/verify-no-archive",
		"go run ./scripts/verify-file-length",
		"go run ./scripts/verify-comments",
		"go tool verify -fast",
	} {
		if strings.Contains(text, forbidden) {
			t.Fatalf(".github/workflows/verify.yml must not contain %q", forbidden)
		}
	}
	for _, want := range []string{
		"go tool verify",
		`go-version: "1.27`,
		"ubuntu-latest",
		"macos-latest",
		"actions/setup-node@",
		"golangci/golangci-lint-action@",
		"install-only: true",
		"install-mode: goinstall",
		"@fission-ai/openspec",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf(".github/workflows/verify.yml missing %q", want)
		}
	}
	if strings.Count(text, "go tool verify") < 1 {
		t.Fatal(".github/workflows/verify.yml must invoke go tool verify")
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

func TestPreCommitUsesGoToolVerifyFast(t *testing.T) {
	text := readRepoFile(t, filepath.Join(".githooks", "pre-commit"))
	if strings.Contains(text, "npm run verify") {
		t.Fatal(".githooks/pre-commit must not run root npm run verify")
	}
	if !strings.Contains(text, "go tool verify -fast") {
		t.Fatal(`.githooks/pre-commit missing "go tool verify -fast"`)
	}
	for _, forbidden := range []string{
		"go test -race",
		"verify-prose",
		"verify-no-archive",
		"verify-file-length",
		"verify-comments",
		"golangci-lint run",
	} {
		if strings.Contains(text, forbidden) {
			t.Fatalf(".githooks/pre-commit must not contain duplicated check %q", forbidden)
		}
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
		if strings.Contains(text, `go-version: "1.25`) {
			t.Fatalf("%s still pins Go 1.25", rel)
		}
	}
}

func TestAgentsDocumentsWorkflowAuthoringBoundary(t *testing.T) {
	for _, rel := range []string{"AGENTS.md", "CLAUDE.md"} {
		text := readRepoFile(t, rel)
		if !strings.Contains(text, "Workflow Authoring") {
			t.Fatalf("%s missing Workflow Authoring", rel)
		}
		if !strings.Contains(text, "Definition") {
			t.Fatalf("%s missing Definition", rel)
		}
	}
}

func TestContributingDocumentsUnifiedVerify(t *testing.T) {
	text := readRepoFile(t, "CONTRIBUTING.md")
	if !strings.Contains(text, "**1.27**") {
		t.Fatal(`CONTRIBUTING.md must require Go **1.27** or newer`)
	}
	if strings.Contains(text, "**1.25**") {
		t.Fatal(`CONTRIBUTING.md must not contain legacy checks block "**1.25**"`)
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
	for _, forbidden := range []string{
		"go test ./...\ngolangci-lint run\ngo run ./scripts/verify-prose",
		"Go tests excluding `e2e`, optional `golangci-lint`, and the `go run ./scripts/verify-*` gates.",
		"`go test ./...`, golangci-lint, and the Go verify scripts",
	} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("%s must not contain legacy checks block %q", rel, forbidden)
		}
	}
}

func scanPathsForForbiddenToolchain(t *testing.T) {
	t.Helper()
	root := repoRoot(t)
	paths := []string{
		"AGENTS.md",
		"CLAUDE.md",
		"CONTRIBUTING.md",
		"README.md",
	}
	for _, dir := range []string{"skills", filepath.Join(".agents", "skills")} {
		_ = filepath.WalkDir(filepath.Join(root, dir), func(path string, d os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() {
				return nil
			}
			if strings.HasSuffix(strings.ToLower(path), ".md") {
				rel, relErr := filepath.Rel(root, path)
				if relErr == nil {
					paths = append(paths, rel)
				}
			}
			return nil
		})
	}

	forbidden := []string{
		"bun test ./test",
		"CI=1 npm run verify",
		"bun build --compile",
		"oven-sh/setup-bun",
		"bun install --frozen-lockfile",
		"bun x semantic-release",
	}
	allowedDocsNpm := []string{
		"npm ci --prefix docs",
		"npm run build --prefix docs",
		"npm ci && npm run build",
	}

	for _, rel := range paths {
		text := readRepoFile(t, rel)
		for _, phrase := range forbidden {
			if strings.Contains(text, phrase) {
				t.Fatalf("%s must not reference repo toolchain %q", rel, phrase)
			}
		}
		if strings.Contains(rel, "docs"+string(os.PathSeparator)) {
			continue
		}
		for _, phrase := range []string{"npm run verify", "bun test", "bun install", "setup-bun"} {
			if !strings.Contains(text, phrase) {
				continue
			}
			allowed := false
			for _, okPhrase := range allowedDocsNpm {
				if strings.Contains(text, okPhrase) {
					allowed = true
					break
				}
			}
			if !allowed {
				t.Fatalf("%s must not reference repo toolchain %q", rel, phrase)
			}
		}
	}
}

func TestSkillsAndDocsHaveNoLegacyToolchainReferences(t *testing.T) {
	scanPathsForForbiddenToolchain(t)
}

func TestPromptfooExampleUsesClaudeAgentSDK(t *testing.T) {
	text := readRepoFile(t, filepath.Join(".agents", "skills", "promptfoo-skill-eval", "promptfooconfig.example.yaml"))
	if strings.Contains(text, "file://") {
		t.Fatal("promptfooconfig.example.yaml must not load deleted file:// JS")
	}
	if !strings.Contains(text, "anthropic:claude-agent-sdk") {
		t.Fatal("promptfooconfig.example.yaml must use anthropic:claude-agent-sdk")
	}
	if !strings.Contains(text, "skill-used") || !strings.Contains(text, "not-skill-used") {
		t.Fatal("promptfooconfig.example.yaml must use built-in skill assertions")
	}
}
