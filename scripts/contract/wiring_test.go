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
		"version: v2.13",
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
	if strings.Contains(text, "version: v2.12") {
		t.Fatal(".github/workflows/verify.yml must not pin golangci-lint v2.12 (buildir panics on Go 1.27 stdlib poll)")
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
	if strings.Contains(text, "golang.org/x/mod v0.39.0") {
		t.Fatal("go.mod must not select golang.org/x/mod v0.39.0 (GO-2026-6179 / GO-2026-6180; use v0.40.0 or later)")
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
	// Concatenate so this test file does not contain the forbidden literals.
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

func TestAgentsDocumentsPluginRuntimeTypeScriptBoundary(t *testing.T) {
	for _, rel := range []string{"AGENTS.md", "CLAUDE.md"} {
		text := readRepoFile(t, rel)
		for _, want := range []string{
			"runtime TypeScript transform",
			"VitePress may keep npm and TypeScript under `docs/`",
		} {
			if !strings.Contains(text, want) {
				t.Fatalf("%s missing %q", rel, want)
			}
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

func TestAgentsDocumentsWorkflowExecutionBoundary(t *testing.T) {
	for _, rel := range []string{"AGENTS.md", "CLAUDE.md"} {
		text := readRepoFile(t, rel)
		if !strings.Contains(text, "Workflow Execution") {
			t.Fatalf("%s missing Workflow Execution", rel)
		}
		engineCell := ""
		for _, line := range strings.Split(text, "\n") {
			if strings.Contains(line, "`internal/engine/`") {
				engineCell = line
				break
			}
		}
		if engineCell == "" {
			t.Fatalf("%s missing internal/engine/ layout row", rel)
		}
		if !strings.Contains(engineCell, "Workflow Execution") {
			t.Fatalf("%s engine layout missing Workflow Execution: %s", rel, engineCell)
		}
		if !strings.Contains(engineCell, "Run") {
			t.Fatalf("%s engine layout missing Run: %s", rel, engineCell)
		}
	}
}

func TestAgentsDocumentsRunObservationBoundary(t *testing.T) {
	for _, rel := range []string{"AGENTS.md", "CLAUDE.md"} {
		text := readRepoFile(t, rel)
		historyCell := layoutCell(t, rel, text, "`internal/history/`")
		if !strings.Contains(historyCell, "Run Observation") {
			t.Fatalf("%s history layout missing Run Observation: %s", rel, historyCell)
		}
		if !strings.Contains(historyCell, "Snapshot") || !strings.Contains(historyCell, "Summary") || !strings.Contains(historyCell, "Detail") {
			t.Fatalf("%s history layout missing Snapshot/Summary/Detail: %s", rel, historyCell)
		}
	}
}

func TestAgentsDocumentsHerdrAdapterBoundary(t *testing.T) {
	for _, rel := range []string{"AGENTS.md", "CLAUDE.md"} {
		text := readRepoFile(t, rel)
		hostCell := layoutCell(t, rel, text, "`internal/host/`")
		if !strings.Contains(hostCell, "Herdr Adapter") {
			t.Fatalf("%s host layout missing Herdr Adapter: %s", rel, hostCell)
		}
	}
}

func layoutCell(t *testing.T, rel, text, marker string) string {
	t.Helper()
	for _, line := range strings.Split(text, "\n") {
		if strings.Contains(line, marker) {
			return line
		}
	}
	t.Fatalf("%s missing %s layout row", rel, marker)
	return ""
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

func TestAgentsDocumentsPickerParityBaseline(t *testing.T) {
	for _, rel := range []string{"AGENTS.md", "CLAUDE.md"} {
		text := readRepoFile(t, rel)
		pickerCell := layoutCell(t, rel, text, "`internal/picker/`")
		if !strings.Contains(pickerCell, "Parity Baseline") {
			t.Fatalf("%s picker layout missing Parity Baseline: %s", rel, pickerCell)
		}
		if !strings.Contains(pickerCell, "picker TUI") {
			t.Fatalf("%s picker layout must still describe picker TUI: %s", rel, pickerCell)
		}
		runsCell := layoutCell(t, rel, text, "`internal/runsbrowser/`")
		if !strings.Contains(runsCell, "Parity Baseline") {
			t.Fatalf("%s runsbrowser layout missing Parity Baseline: %s", rel, runsCell)
		}
		tuiCell := layoutCell(t, rel, text, "`internal/tui/`")
		if !strings.Contains(tuiCell, "Parity Baseline") {
			t.Fatalf("%s tui layout missing Parity Baseline: %s", rel, tuiCell)
		}
		if !strings.Contains(tuiCell, "Charm") {
			t.Fatalf("%s tui layout must mention Charm: %s", rel, tuiCell)
		}
	}
}

func TestParityBaselineFilesExist(t *testing.T) {
	root := repoRoot(t)
	for _, rel := range []string{
		filepath.Join("internal", "picker", "parity.go"),
		filepath.Join("internal", "runsbrowser", "parity.go"),
		filepath.Join("internal", "tui", "charm.go"),
		filepath.Join("docs", "charm-components.md"),
	} {
		path := filepath.Join(root, rel)
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("missing Parity Baseline / Charm artifact %s: %v", rel, err)
		}
	}
}

func TestProductImprovementDoesNotHideParityGap(t *testing.T) {
	agents := readRepoFile(t, "AGENTS.md")
	surfaces := readRepoFile(t, filepath.Join("docs", "surfaces.md"))
	combined := agents + "\n" + surfaces

	required := []string{
		"Product Improvement",
		"Parity Baseline",
		"Charm",
	}
	for _, want := range required {
		if !strings.Contains(combined, want) {
			t.Fatalf("AGENTS.md or docs/surfaces.md missing %q (Product Improvement must not hide a Parity Baseline / Charm gap)", want)
		}
	}

	// Explicit rule: Product Improvement must not hide a missing comparison or verdict.
	hasRule := strings.Contains(agents, "must not hide a missing Parity Baseline") ||
		strings.Contains(agents, "must not hide a missing Parity Baseline comparison or Charm verdict") ||
		strings.Contains(surfaces, "must not hide a missing Parity Baseline") ||
		strings.Contains(surfaces, "must not skip that comparison") ||
		(strings.Contains(agents, "Product Improvement") &&
			strings.Contains(agents, "must not") &&
			strings.Contains(agents, "Parity Baseline") &&
			(strings.Contains(agents, "Charm verdict") || strings.Contains(agents, "Charm")))
	if !hasRule {
		t.Fatal("AGENTS.md or docs/surfaces.md must state that a Product Improvement must not hide a missing Parity Baseline comparison or Charm verdict")
	}

	// Reject wording that treats UX redesign as a substitute for the matrix.
	forbidden := []string{
		"UX redesign substitutes for the Parity Baseline",
		"Product Improvement replaces the Parity Baseline",
		"redesign is enough without Parity Baseline",
		"skip the Parity Baseline when improving UX",
	}
	for _, phrase := range forbidden {
		if strings.Contains(combined, phrase) {
			t.Fatalf("must not treat UX redesign as a substitute for the matrix: found %q", phrase)
		}
	}
}

func TestAgentsCiteVerifyProseGoCommand(t *testing.T) {
	for _, rel := range []string{"AGENTS.md", "CLAUDE.md"} {
		text := readRepoFile(t, rel)
		if strings.Contains(text, "verify-prose.ts") {
			t.Fatalf("%s must not cite verify-prose.ts (gate is go run ./scripts/verify-prose)", rel)
		}
		if !strings.Contains(text, "go run ./scripts/verify-prose") {
			t.Fatalf("%s missing %q", rel, "go run ./scripts/verify-prose")
		}
	}
}

func TestAgentsDocumentsInstallReleaseScript(t *testing.T) {
	for _, rel := range []string{"AGENTS.md", "CLAUDE.md"} {
		text := readRepoFile(t, rel)
		cell := layoutCell(t, rel, text, "`scripts/install-release.sh`")
		if !strings.Contains(cell, "verified") && !strings.Contains(cell, "archive") && !strings.Contains(cell, "install") {
			t.Fatalf("%s install-release layout must describe the verified-archive install path: %s", rel, cell)
		}
	}
}

func TestAgentSkillsTeachGoToolVerifyEntry(t *testing.T) {
	root := repoRoot(t)
	var paths []string
	skillsRoot := filepath.Join(root, ".agents", "skills")
	err := filepath.WalkDir(skillsRoot, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		if strings.EqualFold(filepath.Ext(path), ".md") {
			rel, relErr := filepath.Rel(root, path)
			if relErr == nil {
				paths = append(paths, rel)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, rel := range paths {
		text := readRepoFile(t, rel)
		teachesLeafEntry := strings.Contains(text, "go test ./...\ngo run ./scripts/verify-prose") ||
			strings.Contains(text, "`go test ./...` and the Go verify scripts") ||
			strings.Contains(text, "followed by the Go verify scripts (`go run ./scripts/verify-prose`") ||
			(strings.Contains(text, "`go test ./...`") && strings.Contains(text, "go run ./scripts/verify-prose") &&
				!strings.Contains(text, "go tool verify"))
		if !teachesLeafEntry {
			continue
		}
		if !strings.Contains(text, "go tool verify") {
			t.Errorf("%s teaches leaf go test/verify-* as the entry point but missing %q", rel, "go tool verify")
		}
	}
}
