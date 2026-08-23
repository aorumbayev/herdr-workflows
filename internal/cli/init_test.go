package cli

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/config"
)

func withPluginEnv(t *testing.T) (root, plugin string) {
	t.Helper()
	root = t.TempDir()
	plugin = t.TempDir()
	t.Setenv("HERDR_PLUGIN_CONFIG_DIR", plugin)
	return root, plugin
}

func TestInitDetectedProfilesUseKnownKinds(t *testing.T) {
	kinds := map[string]struct{}{}
	for _, k := range InitSeams.HerdrAgentKinds {
		kinds[k] = struct{}{}
	}
	for name, profile := range InitSeams.DetectProfiles() {
		if !config.ProfileNameRE.MatchString(name) {
			t.Fatalf("profile name %q invalid", name)
		}
		if _, ok := kinds[profile.Kind]; !ok {
			t.Fatalf("profile kind %q not in HerdrAgentKinds", profile.Kind)
		}
	}
}

func TestFormatProfilesYamlEmitsKindObjects(t *testing.T) {
	text := InitSeams.FormatProfilesYaml(ProfilesYAMLInput{
		Profiles:       map[string]config.Profile{"claude": {Kind: "claude"}},
		DefaultProfile: "claude",
	})
	if !strings.Contains(text, `kind: "claude"`) {
		t.Fatalf("yaml = %q", text)
	}
}

func TestRunInitFreshWritesProfilesAndGitignore(t *testing.T) {
	root, _ := withPluginEnv(t)
	result, err := RunInit(root, InitOpts{})
	if err != nil {
		t.Fatal(err)
	}
	if result.Kind != "wrote" {
		t.Fatalf("kind = %q", result.Kind)
	}
	text, err := os.ReadFile(result.Path)
	if err != nil {
		t.Fatal(err)
	}
	body := string(text)
	if !strings.Contains(body, "profiles:") {
		t.Fatalf("yaml = %q", body)
	}
	for _, forbidden := range []string{"agents:", "{prompt}"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("yaml contains %q: %q", forbidden, body)
		}
	}
	ignore, err := os.ReadFile(filepath.Join(root, ".hwf", ".gitignore"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(ignore), "config.local.yaml") {
		t.Fatalf("gitignore = %q", ignore)
	}
	cfg, err := config.LoadConfig(root, os.Getenv)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range result.Profiles {
		if cfg.Profiles[name].Kind != name {
			t.Fatalf("profile %q = %+v", name, cfg.Profiles[name])
		}
	}
	if len(result.Profiles) > 0 {
		sorted := slices.Clone(result.Profiles)
		slices.Sort(sorted)
		if cfg.DefaultProfile != sorted[0] {
			t.Fatalf("default_profile = %q, want %q", cfg.DefaultProfile, sorted[0])
		}
	}
}

func TestRunInitExistingPreservedWithoutConfirmation(t *testing.T) {
	root, _ := withPluginEnv(t)
	hwfDir := filepath.Join(root, ".hwf")
	if err := os.MkdirAll(hwfDir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := config.RepoConfigPath(root)
	if err := os.WriteFile(path, []byte("profiles:\n  claude:\n    kind: claude\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	result, err := RunInit(root, InitOpts{})
	if err != nil {
		t.Fatal(err)
	}
	if result.Kind != "exists" {
		t.Fatalf("kind = %q", result.Kind)
	}
	data, err := os.ReadFile(path)
	if err != nil || !strings.Contains(string(data), "claude") {
		t.Fatalf("config = %q err=%v", data, err)
	}
}

func TestRunInitForcePreservesTranscripts(t *testing.T) {
	root, _ := withPluginEnv(t)
	if err := os.MkdirAll(filepath.Join(root, ".hwf"), 0o755); err != nil {
		t.Fatal(err)
	}
	path := config.RepoConfigPath(root)
	original := "profiles:\n  claude:\n    kind: claude\ntranscripts:\n  claude:\n    command: [\"claude\", \"-p\"]\n"
	if err := os.WriteFile(path, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}
	result, err := RunInit(root, InitOpts{Force: true})
	if err != nil {
		t.Fatal(err)
	}
	if result.Kind != "overwritten" {
		t.Fatalf("kind = %q", result.Kind)
	}
	text, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	body := string(text)
	if !strings.Contains(body, "transcripts:") || !strings.Contains(body, "claude:") {
		t.Fatalf("yaml = %q", body)
	}
	cfg, err := config.LoadConfig(root, os.Getenv)
	if err != nil {
		t.Fatal(err)
	}
	if got := cfg.Transcripts["claude"].Command; len(got) != 2 || got[0] != "claude" || got[1] != "-p" {
		t.Fatalf("transcripts = %+v", cfg.Transcripts["claude"])
	}
}

func TestRunInitSeedsNoWorkflows(t *testing.T) {
	root, _ := withPluginEnv(t)
	if _, err := RunInit(root, InitOpts{}); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(filepath.Join(root, ".hwf", "workflows"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("workflows = %v", entries)
	}
}

func TestRunInitDoesNotWriteHomeHwfConfig(t *testing.T) {
	root, _ := withPluginEnv(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	if _, err := RunInit(root, InitOpts{}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(home, ".hwf", "config.yaml")); !os.IsNotExist(err) {
		t.Fatalf("home config should not exist: %v", err)
	}
}

func TestRunInitGlobalWritesPluginConfig(t *testing.T) {
	root, plugin := withPluginEnv(t)
	result, err := RunInit(root, InitOpts{Global: true})
	if err != nil {
		t.Fatal(err)
	}
	if result.Kind != "wrote" {
		t.Fatalf("kind = %q", result.Kind)
	}
	wantPath := filepath.Join(plugin, "config.yaml")
	if result.Path != wantPath {
		t.Fatalf("path = %q, want %q", result.Path, wantPath)
	}
	if _, err := os.Stat(wantPath); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(config.RepoConfigPath(root)); !os.IsNotExist(err) {
		t.Fatalf("repo config should not exist: %v", err)
	}
	text, err := os.ReadFile(wantPath)
	if err != nil {
		t.Fatal(err)
	}
	body := string(text)
	if !strings.Contains(body, "profiles:") {
		t.Fatalf("yaml = %q", body)
	}
	for _, name := range result.Profiles {
		if !strings.Contains(body, name+":") {
			t.Fatalf("yaml missing profile %q: %q", name, body)
		}
	}
}

func TestRunInitGlobalPreservesExisting(t *testing.T) {
	root, plugin := withPluginEnv(t)
	path := filepath.Join(plugin, "config.yaml")
	if err := os.WriteFile(path, []byte("profiles:\n  claude:\n    kind: claude\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	result, err := RunInit(root, InitOpts{Global: true})
	if err != nil {
		t.Fatal(err)
	}
	if result.Kind != "exists" {
		t.Fatalf("kind = %q", result.Kind)
	}
	data, err := os.ReadFile(path)
	if err != nil || !strings.Contains(string(data), "claude") {
		t.Fatalf("config = %q err=%v", data, err)
	}
}
