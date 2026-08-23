package config

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// Fixture is a global config.yaml sample from a real install, with the
// home directory in the extractor argv replaced by a neutral path.
func TestRealInstallGlobalConfigParses(t *testing.T) {
	data, err := os.ReadFile("testdata/global-config.yaml")
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := ParseConfigText("global-config.yaml", string(data))
	if err != nil {
		t.Fatal(err)
	}
	wantProfiles := map[string]Profile{
		"claude":   {Kind: "claude"},
		"codex":    {Kind: "codex"},
		"cursor":   {Kind: "cursor"},
		"opencode": {Kind: "opencode"},
	}
	if !reflect.DeepEqual(cfg.Profiles, wantProfiles) {
		t.Fatalf("profiles = %+v, want %+v", cfg.Profiles, wantProfiles)
	}
	if cfg.DefaultProfile != "claude" {
		t.Fatalf("default_profile = %q", cfg.DefaultProfile)
	}
	// Legacy-input fixture: extractor argv starts with bun.
	for _, kind := range []string{"codex", "opencode", "kimi"} {
		ex, ok := cfg.Transcripts[kind]
		if !ok || len(ex.Command) != 2 || ex.Command[0] != "bun" {
			t.Fatalf("transcript %q = %+v", kind, ex)
		}
	}
}

// The same fixture loaded as the global layer must merge so later layers
// replace whole profile and transcript entries by name.
func TestRealInstallGlobalConfigLayerReplacement(t *testing.T) {
	plugin := t.TempDir()
	root := t.TempDir()
	t.Setenv("HERDR_PLUGIN_CONFIG_DIR", plugin)
	if err := os.MkdirAll(filepath.Join(root, ".hwf"), 0o755); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile("testdata/global-config.yaml")
	if err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(plugin, "config.yaml"), string(data))
	write(t, filepath.Join(root, ".hwf", "config.yaml"),
		"profiles:\n  claude:\n    kind: claude\n    args: [\"--model\", \"repo\"]\n")
	write(t, filepath.Join(root, ".hwf", "config.local.yaml"),
		"profiles:\n  claude:\n    kind: kimi\ntranscripts:\n  codex:\n    command: [echo, local]\n")
	cfg, err := LoadConfig(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := cfg.Profiles["claude"]; !reflect.DeepEqual(got, Profile{Kind: "kimi"}) {
		t.Fatalf("local must replace whole claude entry: %+v", got)
	}
	if got := cfg.Profiles["codex"]; !reflect.DeepEqual(got, Profile{Kind: "codex"}) {
		t.Fatalf("untouched global codex must survive: %+v", got)
	}
	if got := cfg.Transcripts["codex"].Command; !reflect.DeepEqual(got, []string{"echo", "local"}) {
		t.Fatalf("local transcript replacement = %v", got)
	}
	if _, ok := cfg.Transcripts["kimi"]; !ok {
		t.Fatal("global kimi transcript must survive")
	}
	if cfg.DefaultProfile != "claude" {
		t.Fatalf("default_profile = %q", cfg.DefaultProfile)
	}
}
