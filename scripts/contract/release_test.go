package contract_test

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
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

func TestCommittedSchemaIDMatchesManifestVersion(t *testing.T) {
	root := repoRoot(t)
	toml, err := os.ReadFile(filepath.Join(root, "herdr-plugin.toml"))
	if err != nil {
		t.Fatal(err)
	}
	current := regexp.MustCompile(`(?m)^version\s*=\s*"([^"]+)"`).FindSubmatch(toml)
	if len(current) != 2 {
		t.Fatal("unexpected version in herdr-plugin.toml")
	}
	raw, err := os.ReadFile(filepath.Join(root, "docs", "workflow.schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	var schema struct {
		ID string `json:"$id"`
	}
	if err := json.Unmarshal(raw, &schema); err != nil {
		t.Fatal(err)
	}
	want := "https://raw.githubusercontent.com/aorumbayev/herdr-workflows/v" + string(current[1]) + "/docs/workflow.schema.json"
	if schema.ID != want {
		t.Fatalf("$id = %q, want %q (stamp the schema after the manifest)", schema.ID, want)
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
	embedSchemaPath := filepath.Join(root, "embed", "workflow.schema.json")
	beforeEmbedSchema, err := os.ReadFile(embedSchemaPath)
	if err != nil {
		t.Fatal(err)
	}
	version := string(current[1])
	t.Cleanup(func() {
		_ = os.WriteFile(tomlPath, beforeToml, 0o644)
		embedPath := filepath.Join(root, "embed", "herdr-plugin.toml")
		_ = os.WriteFile(embedPath, beforeToml, 0o644)
		_ = os.WriteFile(schemaPath, beforeSchema, 0o644)
		_ = os.WriteFile(embedSchemaPath, beforeEmbedSchema, 0o644)
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
	embedSchemaPath := filepath.Join(root, "embed", "workflow.schema.json")
	beforeEmbedSchema, err := os.ReadFile(embedSchemaPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = os.WriteFile(tomlPath, beforeToml, 0o644)
		_ = os.WriteFile(filepath.Join(root, "embed", "herdr-plugin.toml"), beforeToml, 0o644)
		_ = os.WriteFile(schemaPath, beforeSchema, 0o644)
		_ = os.WriteFile(embedSchemaPath, beforeEmbedSchema, 0o644)
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
		t.Fatal("expected gh release create")
	}
	if !strings.Contains(text, "CHANGELOG_JSON: ${{ toJSON(steps.dry.outputs.changelog) }}") {
		t.Fatal("expected toJSON changelog env so multiline notes survive YAML")
	}
	if strings.Contains(text, "--draft") {
		t.Fatal("must not draft releases")
	}
	if !strings.Contains(text, "goreleaser") {
		t.Fatal("expected goreleaser after notes/tag")
	}
	if !strings.Contains(text, "checksums.txt") {
		t.Fatal("expected checksums.txt attached to the release")
	}
	if !strings.Contains(text, ".tar.gz") {
		t.Fatal("expected tar.gz archives attached to the release")
	}
	assertGoreleaserArtifactContract(t)
}

func TestReleaseWorkflowRecoversIncompleteGitHubRelease(t *testing.T) {
	text := readRepoFile(t, filepath.Join(".github", "workflows", "release.yml"))
	steps := parseReleaseSteps(t, text)

	tag := mustReleaseStep(t, steps, "Point the release tag at HEAD")
	if tag.If != "steps.dry.outputs.version != ''" {
		t.Fatalf("tag step if = %q (new tags still require a dry version)", tag.If)
	}
	if !strings.Contains(tag.Run, "not moving the tag") {
		t.Fatal("tag step must keep tag idempotence")
	}

	stamp := mustReleaseStep(t, steps, "Stamp plugin version files")
	if stamp.If != "steps.dry.outputs.version != ''" {
		t.Fatalf("stamp step if = %q (recovery must not invent a dry version)", stamp.If)
	}

	recover := mustReleaseStep(t, steps, "Recover a tagged release with missing assets")
	if recover.If != "steps.dry.outputs.version == ''" {
		t.Fatalf("recover step if = %q", recover.If)
	}
	if !strings.Contains(recover.Run, "herdr-plugin.toml") {
		t.Fatal("recovery version must come from the stamped manifest")
	}
	if !strings.Contains(recover.Run, "GITHUB_OUTPUT") {
		t.Fatal("recovery must publish needed/version outputs")
	}
	if !strings.Contains(recover.Run, "gh release view") {
		t.Fatal("recovery must inspect the GitHub Release")
	}
	for _, name := range supportedReleaseAssetNames("${VERSION}") {
		if !strings.Contains(recover.Run, name) {
			t.Fatalf("recovery must require asset %q", name)
		}
	}

	build := mustReleaseStep(t, steps, "Build release archives")
	assertRunsWithoutNewDryVersion(t, "Build release archives", build.If)

	publish := mustReleaseStep(t, steps, "Publish GitHub release")
	assertRunsWithoutNewDryVersion(t, "Publish GitHub release", publish.If)
	if !strings.Contains(publish.Run, "gh release create") {
		t.Fatal("missing GitHub Release must still be created")
	}
	if !strings.Contains(publish.Run, "gh release upload") {
		t.Fatal("incomplete GitHub Release must upload the five assets")
	}
	if !strings.Contains(publish.If, "steps.recover.outputs.needed") {
		t.Fatal("publish must honor recovery needed")
	}
	for _, name := range supportedReleaseAssetNames("${VERSION}") {
		if !strings.Contains(publish.Run, name) {
			t.Fatalf("publish must attach %q", name)
		}
	}
}

func supportedReleaseAssetNames(version string) []string {
	return []string{
		"herdr-workflows_" + version + "_linux_amd64.tar.gz",
		"herdr-workflows_" + version + "_linux_arm64.tar.gz",
		"herdr-workflows_" + version + "_darwin_amd64.tar.gz",
		"herdr-workflows_" + version + "_darwin_arm64.tar.gz",
		"checksums.txt",
	}
}

func assertRunsWithoutNewDryVersion(t *testing.T, name, cond string) {
	t.Helper()
	if cond == "steps.dry.outputs.version != ''" {
		t.Fatalf("%s is gated only on a new dry version; tagged recovery cannot publish assets", name)
	}
	if !strings.Contains(cond, "steps.recover.outputs.needed") {
		t.Fatalf("%s if = %q (must run when recovery is needed)", name, cond)
	}
	if !strings.Contains(cond, "steps.dry.outputs.version") {
		t.Fatalf("%s if = %q (new versions must still publish)", name, cond)
	}
}

type releaseWorkflowStep struct {
	Name string `yaml:"name"`
	If   string `yaml:"if"`
	Run  string `yaml:"run"`
	Uses string `yaml:"uses"`
}

func parseReleaseSteps(t *testing.T, text string) []releaseWorkflowStep {
	t.Helper()
	var doc struct {
		Jobs map[string]struct {
			Steps []releaseWorkflowStep `yaml:"steps"`
		} `yaml:"jobs"`
	}
	if err := yaml.Unmarshal([]byte(text), &doc); err != nil {
		t.Fatalf("parse release.yml: %v", err)
	}
	job, ok := doc.Jobs["semantic-release"]
	if !ok {
		t.Fatal("expected semantic-release job")
	}
	return job.Steps
}

func mustReleaseStep(t *testing.T, steps []releaseWorkflowStep, name string) releaseWorkflowStep {
	t.Helper()
	for _, step := range steps {
		if step.Name == name {
			return step
		}
	}
	t.Fatalf("missing release.yml step %q", name)
	return releaseWorkflowStep{}
}

func TestGoreleaserDefinesSupportedArtifactSet(t *testing.T) {
	assertGoreleaserArtifactContract(t)
}

func assertGoreleaserArtifactContract(t *testing.T) {
	t.Helper()
	cfg := readRepoFile(t, ".goreleaser.yaml")
	if !strings.Contains(cfg, "CGO_ENABLED=0") {
		t.Fatal(".goreleaser.yaml must set CGO_ENABLED=0")
	}
	if !strings.Contains(cfg, "checksums.txt") {
		t.Fatal(".goreleaser.yaml must name checksums.txt")
	}
	for _, want := range []string{"linux", "darwin", "amd64", "arm64", "tar.gz"} {
		if !strings.Contains(cfg, want) {
			t.Fatalf(".goreleaser.yaml missing %q", want)
		}
	}
	if goreleaserPublishesWindows(cfg) {
		t.Fatal(".goreleaser.yaml must not publish a windows archive")
	}
}

func goreleaserPublishesWindows(cfg string) bool {
	inIgnore := false
	for _, line := range strings.Split(cfg, "\n") {
		trim := strings.TrimSpace(line)
		if trim == "" || strings.HasPrefix(trim, "#") {
			continue
		}
		indent := len(line) - len(strings.TrimLeft(line, " \t"))
		if strings.HasPrefix(trim, "ignore:") {
			inIgnore = true
			continue
		}
		if inIgnore && indent == 0 {
			inIgnore = false
		}
		if inIgnore {
			continue
		}
		if trim == "- windows" || trim == "goos: windows" || strings.Contains(trim, "windows_") {
			return true
		}
	}
	return false
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

const releaseNotesFooter = "### Install requirements\n\nRemote install via Herdr downloads the verified release archive. The target host does not need Go."

func TestWriteReleaseNotesAppendsVerifiedArchiveFooter(t *testing.T) {
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
