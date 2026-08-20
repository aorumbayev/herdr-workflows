package contract_test

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func runPrepareRelease(t *testing.T, args ...string) (stdout, stderr string, code int) {
	t.Helper()
	root := repoRoot(t)
	cmd := exec.Command("go", append([]string{"run", "./scripts/prepare-release"}, args...)...)
	cmd.Dir = root
	var outBuf, errBuf strings.Builder
	cmd.Stdout = &outBuf
	cmd.Stderr = &errBuf
	err := cmd.Run()
	code = 0
	if err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			code = exit.ExitCode()
		} else {
			t.Fatalf("run prepare-release: %v", err)
		}
	}
	return outBuf.String(), errBuf.String(), code
}

func TestPrepareReleaseUpdatesFixtureTomlOnly(t *testing.T) {
	dir := t.TempDir()
	toml := filepath.Join(dir, "herdr-plugin.toml")
	before := `id = "herdr-workflows"
version = "0.1.0"
name = "herdr-workflows"
`
	if err := os.WriteFile(toml, []byte(before), 0o644); err != nil {
		t.Fatal(err)
	}
	stdout, _, code := runPrepareRelease(t, "0.2.0", toml)
	if code != 0 {
		t.Fatalf("code = %d stdout = %q", code, stdout)
	}
	if !strings.Contains(stdout, "0.2.0") {
		t.Fatalf("stdout = %q", stdout)
	}
	if strings.Contains(stdout, "regenerated docs/workflow.schema.json") {
		t.Fatalf("stdout = %q", stdout)
	}
	got, err := os.ReadFile(toml)
	if err != nil {
		t.Fatal(err)
	}
	want := `id = "herdr-workflows"
version = "0.2.0"
name = "herdr-workflows"
`
	if string(got) != want {
		t.Fatalf("toml = %q, want %q", got, want)
	}
}

func TestPrepareReleaseDefaultRegeneratesSchemaID(t *testing.T) {
	root := repoRoot(t)
	tomlPath := filepath.Join(root, "herdr-plugin.toml")
	schemaPath := filepath.Join(root, "docs", "workflow.schema.json")
	beforeToml, err := os.ReadFile(tomlPath)
	if err != nil {
		t.Fatal(err)
	}
	current := regexp.MustCompile(`(?m)^version\s*=\s*"([^"]+)"`).FindSubmatch(beforeToml)
	if len(current) != 2 || !regexp.MustCompile(`^\d+\.\d+\.\d+$`).Match(current[1]) {
		t.Fatalf("unexpected version in herdr-plugin.toml")
	}
	beforeSchema, err := os.ReadFile(schemaPath)
	if err != nil {
		t.Fatal(err)
	}
	version := string(current[1])
	t.Cleanup(func() {
		_ = os.WriteFile(tomlPath, beforeToml, 0o644)
		embedPath := filepath.Join(root, "embed", "herdr-plugin.toml")
		_ = os.WriteFile(embedPath, beforeToml, 0o644)
		_ = os.WriteFile(schemaPath, beforeSchema, 0o644)
	})
	stdout, stderr, code := runPrepareRelease(t, version)
	if code != 0 {
		t.Fatalf("code = %d stderr = %q stdout = %q", code, stderr, stdout)
	}
	if !strings.Contains(stdout, "regenerated docs/workflow.schema.json") {
		t.Fatalf("stdout = %q", stdout)
	}
	schemaRaw, err := os.ReadFile(schemaPath)
	if err != nil {
		t.Fatal(err)
	}
	var schema struct {
		ID string `json:"$id"`
	}
	if err := json.Unmarshal(schemaRaw, &schema); err != nil {
		t.Fatal(err)
	}
	wantID := "https://raw.githubusercontent.com/aorumbayev/herdr-workflows/v" + version + "/docs/workflow.schema.json"
	if schema.ID != wantID {
		t.Fatalf("$id = %q, want %q", schema.ID, wantID)
	}
}

func TestPrepareReleaseResolvesRepoRootFromNestedCwd(t *testing.T) {
	root := repoRoot(t)
	tomlPath := filepath.Join(root, "herdr-plugin.toml")
	schemaPath := filepath.Join(root, "docs", "workflow.schema.json")
	beforeToml, err := os.ReadFile(tomlPath)
	if err != nil {
		t.Fatal(err)
	}
	current := regexp.MustCompile(`(?m)^version\s*=\s*"([^"]+)"`).FindSubmatch(beforeToml)
	if len(current) != 2 {
		t.Fatalf("unexpected version in herdr-plugin.toml")
	}
	beforeSchema, err := os.ReadFile(schemaPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = os.WriteFile(tomlPath, beforeToml, 0o644)
		_ = os.WriteFile(filepath.Join(root, "embed", "herdr-plugin.toml"), beforeToml, 0o644)
		_ = os.WriteFile(schemaPath, beforeSchema, 0o644)
	})

	cmd := exec.Command("go", "run", filepath.Join(root, "scripts", "prepare-release"), string(current[1]))
	cmd.Dir = filepath.Join(root, "scripts")
	var outBuf, errBuf strings.Builder
	cmd.Stdout = &outBuf
	cmd.Stderr = &errBuf
	if err := cmd.Run(); err != nil {
		t.Fatalf("prepare-release from scripts/: %v stderr = %q stdout = %q", err, errBuf.String(), outBuf.String())
	}
	if !strings.Contains(outBuf.String(), tomlPath) {
		t.Fatalf("stdout = %q, want stamped path %q", outBuf.String(), tomlPath)
	}
	if strings.Contains(outBuf.String(), filepath.Join(root, "release", "herdr-plugin.toml")) {
		t.Fatalf("stamped nested path: stdout = %q", outBuf.String())
	}
	if strings.Contains(outBuf.String(), filepath.Join(root, "scripts", "herdr-plugin.toml")) {
		t.Fatalf("stamped nested path: stdout = %q", outBuf.String())
	}
}

func TestReleaseWorkflowHasNoNodeToolchain(t *testing.T) {
	text := readRepoFile(t, filepath.Join(".github", "workflows", "release.yml"))
	for _, forbidden := range []string{
		"setup-node",
		"npm ci",
		"npx",
		"working-directory: release",
	} {
		if strings.Contains(text, forbidden) {
			t.Fatalf(".github/workflows/release.yml must not contain %q", forbidden)
		}
	}
}

func TestPrepareReleaseRejectsMalformedVersions(t *testing.T) {
	_, stderr, code := runPrepareRelease(t, "v0.2.0")
	if code == 0 {
		t.Fatal("expected non-zero exit")
	}
	if !strings.Contains(stderr, "expected x.y.z") {
		t.Fatalf("stderr = %q", stderr)
	}
}

func TestReleaseWorkflowRunsSemanticReleaseByDispatch(t *testing.T) {
	root := repoRoot(t)
	raw, err := os.ReadFile(filepath.Join(root, ".github", "workflows", "release.yml"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	if !strings.Contains(text, "workflow_dispatch:") {
		t.Fatal("expected workflow_dispatch trigger")
	}
	if strings.Contains(text, "\npush:") || strings.Contains(text, "push:\n") {
		t.Fatal("must not trigger on push")
	}
	if !strings.Contains(text, "concurrency:") || !strings.Contains(text, "group: release") {
		t.Fatal("expected release concurrency group")
	}
	if !strings.Contains(text, "setup-go") {
		t.Fatal("expected Go toolchain setup")
	}
	if strings.Contains(text, "setup-node") || strings.Contains(text, "npm ci") || strings.Contains(text, "npx") {
		t.Fatal("release workflow must not use Node semantic-release")
	}
	if strings.Contains(text, "working-directory: release") {
		t.Fatal("release workflow must not use release/ npm adapter")
	}
	if strings.Contains(text, "bun build") || strings.Contains(text, "setup-bun") || strings.Contains(text, "bun install") {
		t.Fatal("release workflow must not use bun")
	}
	if !strings.Contains(text, "go-semantic-release/action@2e9dc4247a6004f8377781bef4cb9dad273a741f") {
		t.Fatal("expected pinned go-semantic-release action")
	}
	if !strings.Contains(text, "allow-initial-development-versions: true") {
		t.Fatal("expected allow-initial-development-versions on dry-run action")
	}
	if !strings.Contains(text, "dry: true") {
		t.Fatal("expected dry-run go-semantic-release step")
	}
	if !strings.Contains(text, "github-token: ${{ steps.app-token.outputs.token }}") {
		t.Fatal("expected app installation token for go-semantic-release")
	}
	if !strings.Contains(text, "actions/create-github-app-token@") {
		t.Fatal("expected GitHub App token checkout")
	}
	if !strings.Contains(text, "go run ./scripts/prepare-release") {
		t.Fatal("expected prepare-release stamp step")
	}
	if !strings.Contains(text, "chore(release): $VERSION [skip ci]") {
		t.Fatal("expected release commit message")
	}
	if !strings.Contains(text, "gh release create") {
		t.Fatal("expected gh release create for notes-only publish")
	}
	if !strings.Contains(text, "CHANGELOG_JSON: ${{ toJSON(steps.dry.outputs.changelog) }}") {
		t.Fatal("expected toJSON changelog env so multiline notes survive YAML")
	}
	if strings.Contains(text, "--draft") {
		t.Fatal("must not draft releases")
	}
	if strings.Contains(text, "goreleaser") {
		t.Fatal("must not use goreleaser")
	}
}

func TestSemrelrcUsesGitHubProvider(t *testing.T) {
	root := repoRoot(t)
	raw, err := os.ReadFile(filepath.Join(root, ".semrelrc"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	if !strings.Contains(text, `"github"`) {
		t.Fatal("expected github provider in .semrelrc")
	}
	if strings.Contains(text, "goreleaser") {
		t.Fatal("must not configure goreleaser in .semrelrc")
	}
	var cfg struct {
		Plugins struct {
			CommitAnalyzer struct {
				Options struct {
					MinorReleaseRules string `json:"minor_release_rules"`
					PatchReleaseRules string `json:"patch_release_rules"`
				} `json:"options"`
			} `json:"commit-analyzer"`
			CICondition struct {
				Name string `json:"name"`
			} `json:"ci-condition"`
			ChangelogGenerator struct {
				Name string `json:"name"`
			} `json:"changelog-generator"`
			Provider struct {
				Name string `json:"name"`
			} `json:"provider"`
		} `json:"plugins"`
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.Plugins.CommitAnalyzer.Options.MinorReleaseRules != "feat" {
		t.Fatalf("minor_release_rules = %q", cfg.Plugins.CommitAnalyzer.Options.MinorReleaseRules)
	}
	if cfg.Plugins.CommitAnalyzer.Options.PatchReleaseRules != "fix,perf,revert" {
		t.Fatalf("patch_release_rules = %q", cfg.Plugins.CommitAnalyzer.Options.PatchReleaseRules)
	}
	if cfg.Plugins.CICondition.Name != "github" {
		t.Fatalf("ci-condition = %q", cfg.Plugins.CICondition.Name)
	}
	if cfg.Plugins.ChangelogGenerator.Name != "default" {
		t.Fatalf("changelog-generator = %q", cfg.Plugins.ChangelogGenerator.Name)
	}
	if cfg.Plugins.Provider.Name != "github" {
		t.Fatalf("provider = %q", cfg.Plugins.Provider.Name)
	}
	releaseYml := readRepoFile(t, filepath.Join(".github", "workflows", "release.yml"))
	if !strings.Contains(releaseYml, "allow-initial-development-versions: true") {
		t.Fatal("allow-initial-development-versions must be set on go-semantic-release action in release.yml")
	}
}

const releaseNotesFooter = "### Install requirements\n\nRemote install via Herdr requires **Go 1.25** or newer on the host."

func TestWriteReleaseNotesAppendsGoToolchainFooter(t *testing.T) {
	root := repoRoot(t)
	dest := filepath.Join(t.TempDir(), "notes.md")
	changelog := "## Features\n\n- add release notes\n"
	encoded, err := json.Marshal(changelog)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("go", "run", "./scripts/write-release-notes", dest)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "CHANGELOG_JSON="+string(encoded))
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("write-release-notes: %v\n%s", err, out)
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	text := string(got)
	if !strings.Contains(text, "Features") || !strings.Contains(text, "add release notes") {
		t.Fatalf("notes = %q", text)
	}
	if !strings.Contains(text, releaseNotesFooter) {
		t.Fatalf("notes missing footer:\n%s", text)
	}
	if !strings.HasSuffix(text, releaseNotesFooter+"\n") {
		t.Fatalf("footer must be last block:\n%s", text)
	}
}
