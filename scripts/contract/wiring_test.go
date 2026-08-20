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

func TestVerifyWorkflowHasNoBunOrRootNpmVerify(t *testing.T) {
	text := readRepoFile(t, filepath.Join(".github", "workflows", "verify.yml"))
	for _, forbidden := range []string{
		"setup-bun",
		"bun test",
		"npm run verify",
		"bun install",
	} {
		if strings.Contains(text, forbidden) {
			t.Fatalf(".github/workflows/verify.yml must not contain %q", forbidden)
		}
	}
	for _, want := range []string{
		"npm ci",
		"working-directory: docs",
		"go test -race ./...",
		"go run ./scripts/verify-prose",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf(".github/workflows/verify.yml missing %q", want)
		}
	}
}

func TestPreCommitHasNoRootNpmVerify(t *testing.T) {
	text := readRepoFile(t, filepath.Join(".githooks", "pre-commit"))
	if strings.Contains(text, "npm run verify") {
		t.Fatal(".githooks/pre-commit must not run root npm run verify")
	}
	for _, want := range []string{
		"go test -race",
		"verify-prose",
		"verify-no-archive",
		"verify-file-length",
		"verify-comments",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf(".githooks/pre-commit missing %q", want)
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
