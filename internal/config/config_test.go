package config

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// fixture returns a plugin config dir and a repo root, both under t.TempDir,
// with HERDR_PLUGIN_CONFIG_DIR pointing at the plugin dir.
func fixture(t *testing.T) (plugin, root string) {
	t.Helper()
	plugin = t.TempDir()
	root = t.TempDir()
	t.Setenv("HERDR_PLUGIN_CONFIG_DIR", plugin)
	if err := os.MkdirAll(filepath.Join(root, ".hwf"), 0o755); err != nil {
		t.Fatal(err)
	}
	return plugin, root
}

func write(t *testing.T, path, text string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestLocalReplacesWholeCommittedProfileEntry(t *testing.T) {
	plugin, root := fixture(t)
	write(t, filepath.Join(plugin, "config.yaml"),
		"profiles:\n  implementation:\n    kind: claude\n    args: [\"--model\", \"global\"]\ndefault_profile: implementation\n")
	write(t, filepath.Join(root, ".hwf", "config.yaml"),
		"profiles:\n  implementation:\n    kind: claude\n    args: [\"--model\", \"repo\"]\n")
	write(t, filepath.Join(root, ".hwf", "config.local.yaml"),
		"profiles:\n  implementation:\n    kind: codex\n")
	cfg, err := LoadConfig(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := cfg.Profiles["implementation"]; !reflect.DeepEqual(got, Profile{Kind: "codex"}) {
		t.Fatalf("profile = %+v, want whole local replacement", got)
	}
	if cfg.DefaultProfile != "implementation" {
		t.Fatalf("default_profile = %q", cfg.DefaultProfile)
	}
}

func TestHighestPrecedenceDefaultProfileMustResolveAfterMerge(t *testing.T) {
	_, root := fixture(t)
	write(t, filepath.Join(root, ".hwf", "config.yaml"),
		"profiles:\n  claude:\n    kind: claude\ndefault_profile: claude\n")
	local := filepath.Join(root, ".hwf", "config.local.yaml")
	write(t, local, "default_profile: missing\n")
	_, err := LoadConfig(root, nil)
	if err == nil ||
		!strings.Contains(err.Error(), local) ||
		!strings.Contains(err.Error(), "default_profile 'missing' is not a merged profile") {
		t.Fatalf("err = %v", err)
	}
}

func TestUnresolvableDefaultProfileBlamesDeclaringLocalLayer(t *testing.T) {
	_, root := fixture(t)
	write(t, filepath.Join(root, ".hwf", "config.yaml"), "profiles:\n  claude:\n    kind: claude\n")
	local := filepath.Join(root, ".hwf", "config.local.yaml")
	write(t, local, "default_profile: nowhere\n")
	_, err := LoadConfig(root, nil)
	if err == nil || !strings.Contains(err.Error(), local+", default_profile:") {
		t.Fatalf("err = %v", err)
	}
}

func TestLegacyAgentsAndSessionsRejectedAsUnknownKeys(t *testing.T) {
	for _, key := range []string{"agents", "sessions"} {
		_, err := ParseConfigText("c.yaml", key+":\n  claude: [claude]\n")
		if err == nil || !strings.Contains(err.Error(), `Unrecognized key: "`+key+`"`) {
			t.Fatalf("%s: err = %v", key, err)
		}
	}
}

func TestProfileRequiresNonEmptyKindAndArgs(t *testing.T) {
	if _, err := ParseConfigText("c.yaml", "profiles:\n  x:\n    kind: \"\"\n"); err == nil ||
		!strings.Contains(err.Error(), "kind") {
		t.Fatalf("empty kind: err = %v", err)
	}
	if _, err := ParseConfigText("c.yaml", "profiles:\n  x:\n    kind: claude\n    args: []\n"); err == nil ||
		!strings.Contains(err.Error(), "args") {
		t.Fatalf("empty args: err = %v", err)
	}
	cfg, err := ParseConfigText("c.yaml",
		"profiles:\n  deep-review:\n    kind: claude\n    args: [\"--model\", \"opus\"]\ndefault_profile: deep-review\n")
	if err != nil {
		t.Fatal(err)
	}
	want := Profile{Kind: "claude", Args: []string{"--model", "opus"}}
	if !reflect.DeepEqual(cfg.Profiles["deep-review"], want) {
		t.Fatalf("profile = %+v, want %+v", cfg.Profiles["deep-review"], want)
	}
	if cfg.DefaultProfile != "deep-review" {
		t.Fatalf("default_profile = %q", cfg.DefaultProfile)
	}
}

func TestEmptyLayerParsesAsEmptyConfig(t *testing.T) {
	for _, text := range []string{"", "\n\n", "# only a comment\n"} {
		cfg, err := ParseConfigText("c.yaml", text)
		if err != nil {
			t.Fatalf("%q: err = %v", text, err)
		}
		if len(cfg.Profiles) != 0 || len(cfg.Transcripts) != 0 || cfg.DefaultProfile != "" {
			t.Fatalf("%q: cfg = %+v", text, cfg)
		}
	}
}

func TestMultiDocumentConfigRejected(t *testing.T) {
	_, err := ParseConfigText("c.yaml", "profiles:\n  a:\n    kind: claude\n---\ndefault_profile: a\n")
	if err == nil || !strings.Contains(err.Error(), "single YAML document") {
		t.Fatalf("err = %v", err)
	}
}

func TestTranscriptKindMustBeNonEmpty(t *testing.T) {
	_, err := ParseConfigText("c.yaml", "transcripts:\n  \"\":\n    command: [echo]\n")
	if err == nil || !strings.Contains(err.Error(), "transcript kind") {
		t.Fatalf("err = %v", err)
	}
}

func TestValidationErrorIsDeterministic(t *testing.T) {
	text := "profiles:\n  Bad:\n    kind: claude\n  Worse:\n    kind: claude\n  Awful:\n    kind: claude\n"
	_, first := ParseConfigText("c.yaml", text)
	for range 20 {
		if _, err := ParseConfigText("c.yaml", text); err.Error() != first.Error() {
			t.Fatalf("nondeterministic: %v vs %v", err, first)
		}
	}
}

func TestPluginStateDirFailsWithoutHome(t *testing.T) {
	env := func(name string) string { return "" }
	t.Setenv("HOME", "")
	if _, err := PluginStateDir(env); err == nil {
		t.Fatal("PluginStateDir must fail loud when the home directory is unknown")
	}
	dir, err := PluginStateDir(func(name string) string {
		if name == "HERDR_PLUGIN_STATE_DIR" {
			return "/tmp/state"
		}
		return ""
	})
	if err != nil || dir != "/tmp/state" {
		t.Fatalf("dir = %q, err = %v", dir, err)
	}
}

func TestProfileNamesMatchIdentifierRules(t *testing.T) {
	_, err := ParseConfigText("c.yaml", "profiles:\n  Bad:\n    kind: claude\n")
	if err == nil || !strings.Contains(err.Error(), "profile name") {
		t.Fatalf("err = %v", err)
	}
}

func TestTranscriptExtractorsReplaceByKindName(t *testing.T) {
	plugin, root := fixture(t)
	write(t, filepath.Join(plugin, "config.yaml"),
		"transcripts:\n  claude:\n    command: [echo, global]\n  codex:\n    command: [echo, keep]\n")
	write(t, filepath.Join(root, ".hwf", "config.yaml"),
		"transcripts:\n  claude:\n    command: [echo, repo]\n")
	cfg, err := LoadConfig(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := cfg.Transcripts["claude"].Command; !reflect.DeepEqual(got, []string{"echo", "repo"}) {
		t.Fatalf("claude command = %v", got)
	}
	if got := cfg.Transcripts["codex"].Command; !reflect.DeepEqual(got, []string{"echo", "keep"}) {
		t.Fatalf("codex command = %v", got)
	}
	if _, ok := ResolveProfile(cfg, "implementation"); ok {
		t.Fatal("unexpected profile")
	}
	if got := RepoLocalConfigPath(root); got != filepath.Join(root, ".hwf", "config.local.yaml") {
		t.Fatalf("local path = %q", got)
	}
}

func TestResolvePluginConfigDirEnvWinsWithoutCallingHerdr(t *testing.T) {
	plugin, _ := fixture(t)
	dir, err := ResolvePluginConfigDir(nil)
	if err != nil {
		t.Fatal(err)
	}
	if dir != plugin {
		t.Fatalf("dir = %q, want %q", dir, plugin)
	}
}

func TestResolvePluginConfigDirDiscoversViaHerdrCLI(t *testing.T) {
	plugin := t.TempDir()
	t.Setenv("HERDR_PLUGIN_CONFIG_DIR", "")
	fakeBin := filepath.Join(plugin, "fake-herdr")
	write(t, fakeBin, "#!/bin/sh\nif [ \"$1\" = plugin ] && [ \"$2\" = config-dir ] && [ \"$3\" = herdr-workflows ]; then\n  printf '%s\\n' \""+plugin+"\"\n  exit 0\nfi\nexit 1\n")
	if err := os.Chmod(fakeBin, 0o755); err != nil {
		t.Fatal(err)
	}
	getenv := func(key string) string {
		if key == "HERDR_BIN_PATH" {
			return fakeBin
		}
		return os.Getenv(key)
	}
	dir, err := ResolvePluginConfigDir(getenv)
	if err != nil {
		t.Fatal(err)
	}
	if dir != plugin {
		t.Fatalf("dir = %q, want %q", dir, plugin)
	}
}

func TestResolvePluginConfigDirDiscoveryFailure(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_CONFIG_DIR", "")
	getenv := func(key string) string {
		if key == "HERDR_BIN_PATH" {
			return filepath.Join(t.TempDir(), "missing-herdr")
		}
		return os.Getenv(key)
	}
	_, err := ResolvePluginConfigDir(getenv)
	if err == nil || !strings.Contains(err.Error(), "failed to discover plugin config directory") {
		t.Fatalf("err = %v", err)
	}
}

func TestPlatformNameFor(t *testing.T) {
	cases := map[string]PlatformName{
		"darwin":  PlatformMacOS,
		"linux":   PlatformLinux,
		"win32":   PlatformLinux,
		"freebsd": PlatformLinux,
		"windows": PlatformLinux,
	}
	for goos, want := range cases {
		if got := PlatformNameFor(goos); got != want {
			t.Errorf("PlatformNameFor(%q) = %q, want %q", goos, got, want)
		}
	}
}

func TestProfileNamesSorted(t *testing.T) {
	cfg := Config{Profiles: map[string]Profile{
		"zebra": {Kind: "codex"},
		"alpha": {Kind: "claude", Args: []string{"--model", "secret"}},
	}}
	if got := ProfileNames(cfg); !reflect.DeepEqual(got, []string{"alpha", "zebra"}) {
		t.Fatalf("names = %v", got)
	}
}

func TestLoadContextEmptyRepoRootEnvTreatedAsUnset(t *testing.T) {
	_, root := fixture(t)
	t.Setenv("HERDR_WORKFLOWS_REPO_ROOT", "")
	t.Chdir(root)
	app, err := LoadContext(LoadOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if app.RepoRoot == "" {
		t.Fatal("repo root must resolve")
	}
	cwd, _ := os.Getwd()
	if app.RepoRoot != ResolveRepoRoot(cwd) {
		t.Fatalf("repoRoot = %q", app.RepoRoot)
	}
}

func TestLoadContextWalksFromCwdNotInvocationPaneCwd(t *testing.T) {
	_, root := fixture(t)
	pane := t.TempDir()
	if err := os.MkdirAll(filepath.Join(pane, ".hwf"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HERDR_PLUGIN_CONTEXT_JSON", `{"focused_pane_cwd": "`+pane+`"}`)
	t.Chdir(root)
	app, err := LoadContext(LoadOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if app.RepoRoot != root {
		t.Fatalf("repoRoot = %q, want %q", app.RepoRoot, root)
	}
}

func TestLoadContextFromInvocationWalksFromPaneCwd(t *testing.T) {
	_, root := fixture(t)
	pane := t.TempDir()
	if err := os.MkdirAll(filepath.Join(pane, ".hwf"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HERDR_PLUGIN_CONTEXT_JSON", `{"focused_pane_cwd": "`+pane+`"}`)
	t.Chdir(root)
	app, err := LoadContext(LoadOptions{FromInvocation: true})
	if err != nil {
		t.Fatal(err)
	}
	if app.RepoRoot != ResolveRepoRoot(pane) {
		t.Fatalf("repoRoot = %q, want %q", app.RepoRoot, ResolveRepoRoot(pane))
	}
	if app.RepoRoot == root {
		t.Fatal("fromInvocation must not resolve from cwd")
	}
}

func TestResolveRepoRootWalksUp(t *testing.T) {
	root := t.TempDir()
	nested := filepath.Join(root, "a", "b")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	if got := ResolveRepoRoot(nested); got != nested {
		t.Fatalf("no marker found must return start: got %q, want %q", got, nested)
	}
	if err := os.MkdirAll(filepath.Join(root, ".hwf"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got := ResolveRepoRoot(nested); got != root {
		t.Fatalf("got %q, want %q", got, root)
	}
}

func TestResolveRepoRootIgnoresHomeHwf(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.MkdirAll(filepath.Join(home, ".hwf", "workflows"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got := ResolveRepoRoot(home); got != home {
		t.Fatalf("home must fall through to start: got %q, want %q", got, home)
	}
	nested := filepath.Join(home, "Downloads")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	if got := ResolveRepoRoot(nested); got != nested {
		t.Fatalf("global .hwf must not claim a non-repo dir: got %q, want %q", got, nested)
	}
	if err := os.MkdirAll(filepath.Join(home, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got := ResolveRepoRoot(nested); got != home {
		t.Fatalf(".git at home is still a root: got %q, want %q", got, home)
	}
}

func TestReadInvocationContextUsesHerdrFields(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_CONTEXT_JSON", `{"workspace_cwd":"/ws","focused_pane_cwd":"/pane","worktree":{"checkout_path":"/wt"}}`)
	ctx := readInvocationContext(nil)
	if ctx.WorktreePath != "/wt" {
		t.Fatalf("worktree path = %q", ctx.WorktreePath)
	}
	if ctx.Cwd != "/wt" {
		t.Fatalf("worktree checkout_path must win: cwd = %q", ctx.Cwd)
	}

	t.Setenv("HERDR_PLUGIN_CONTEXT_JSON", `{"workspace_cwd":"/ws","focused_pane_cwd":"/pane"}`)
	if ctx := readInvocationContext(nil); ctx.Cwd != "/pane" {
		t.Fatalf("focused_pane_cwd must win over workspace_cwd: cwd = %q", ctx.Cwd)
	}

	t.Setenv("HERDR_PLUGIN_CONTEXT_JSON", `{"workspace_cwd":"/ws"}`)
	if ctx := readInvocationContext(nil); ctx.Cwd != "/ws" {
		t.Fatalf("workspace_cwd must be the last injected fallback: cwd = %q", ctx.Cwd)
	}

	dir := t.TempDir()
	t.Chdir(dir)
	t.Setenv("HERDR_PLUGIN_CONTEXT_JSON", `{"selected_text":"x"}`)
	got, err := filepath.EvalSymlinks(readInvocationContext(nil).Cwd)
	if err != nil {
		t.Fatal(err)
	}
	want, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("no injected cwd must fall back to getwd: got %q, want %q", got, want)
	}
}

func TestLatestWinsToken(t *testing.T) {
	var g Generation
	first := g.Begin()
	second := g.Begin()
	if g.Current(first) {
		t.Fatal("older generation must not be current")
	}
	if !g.Current(second) {
		t.Fatal("latest generation must be current")
	}
	if !g.Current(g.Begin()) {
		t.Fatal("new generation must be current")
	}
}

func TestSanitizeDisplay(t *testing.T) {
	raw := "a\x00b\x07c\x1bd\te\rf\ng\x7fh"
	if got := SanitizeDisplay(raw); got != "abcd\te\rf\ng\x7fh" {
		t.Fatalf("got %q", got)
	}
}

func TestEnsureLocalConfigGitignored(t *testing.T) {
	root := t.TempDir()
	if err := EnsureLocalConfigGitignored(root); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(root, ".hwf", ".gitignore"))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "config.local.yaml\ntmp/\n" {
		t.Fatalf("gitignore = %q", data)
	}
	if err := EnsureLocalConfigGitignored(root); err != nil {
		t.Fatal(err)
	}
	again, _ := os.ReadFile(filepath.Join(root, ".hwf", ".gitignore"))
	if string(again) != string(data) {
		t.Fatal("second run must be idempotent")
	}
}

func TestNoProfilesConfiguredMessage(t *testing.T) {
	msg := NoProfilesConfiguredMessage("/g/config.yaml", "/r/.hwf/config.yaml")
	for _, want := range []string{"no profiles configured", "/g/config.yaml", "/r/.hwf/config.yaml", "hwf init", "hwf init --global"} {
		if !strings.Contains(msg, want) {
			t.Errorf("message missing %q: %s", want, msg)
		}
	}
}
