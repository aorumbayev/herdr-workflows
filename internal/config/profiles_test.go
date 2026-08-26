package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestListProfilesReportsHighestPriorityLayer(t *testing.T) {
	plugin, root := fixture(t)
	write(t, filepath.Join(plugin, "config.yaml"),
		"profiles:\n  global_only:\n    kind: claude\n  shared:\n    kind: claude\n")
	write(t, filepath.Join(root, ".hwf", "config.yaml"),
		"profiles:\n  repo_only:\n    kind: codex\n  shared:\n    kind: codex\n")
	write(t, filepath.Join(root, ".hwf", "config.local.yaml"),
		"profiles:\n  shared:\n    kind: gemini\n")
	got, err := ListProfiles(root, nil)
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]ProfileEntry{}
	for _, p := range got {
		byName[p.Name] = p
	}
	if byName["global_only"].Source != "global" || byName["global_only"].File != filepath.Join(plugin, "config.yaml") {
		t.Fatalf("global_only = %+v", byName["global_only"])
	}
	if byName["repo_only"].Source != "repo" || byName["repo_only"].File != filepath.Join(root, ".hwf", "config.yaml") {
		t.Fatalf("repo_only = %+v", byName["repo_only"])
	}
	if byName["shared"].Source != "local" || byName["shared"].Kind != "gemini" {
		t.Fatalf("shared must resolve to the local layer: %+v", byName["shared"])
	}
	if len(got) != 3 || got[0].Name != "global_only" {
		t.Fatalf("expected three sorted profiles: %+v", got)
	}
}

func TestAppendProfileSkeletonCreatesLoadableFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "nested", "config.yaml")
	if err := AppendProfileSkeleton(path, "intake"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := ParseConfigText(path, string(data))
	if err != nil {
		t.Fatalf("created file must load: %v", err)
	}
	if p, ok := cfg.Profiles["intake"]; !ok || p.Kind != "claude" {
		t.Fatalf("skeleton profile = %+v ok=%v", p, ok)
	}
}

func TestAppendProfileSkeletonPreservesCommentsAndEntries(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	original := "# keep me\nprofiles:\n  existing:\n    kind: claude # inline note\n    args: [\"--flag\"]\ndefault_profile: existing\n"
	write(t, path, original)
	if err := AppendProfileSkeleton(path, "review"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	if !strings.Contains(text, "# keep me") || !strings.Contains(text, "# inline note") {
		t.Fatalf("comments dropped:\n%s", text)
	}
	if !strings.Contains(text, "existing:") || !strings.Contains(text, "default_profile: existing") {
		t.Fatalf("existing entries dropped:\n%s", text)
	}
	cfg, err := ParseConfigText(path, text)
	if err != nil {
		t.Fatalf("result must load: %v", err)
	}
	if _, ok := cfg.Profiles["review"]; !ok {
		t.Fatalf("new profile missing:\n%s", text)
	}
	if p := cfg.Profiles["existing"]; p.Kind != "claude" || len(p.Args) != 1 {
		t.Fatalf("existing profile changed: %+v", p)
	}
}

func TestAppendProfileSkeletonMatchesExistingIndent(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	original := "# keep me\nprofiles:\n    existing:\n        kind: claude # inline note\n        args: [\"--flag\"]\ndefault_profile: existing\n"
	write(t, path, original)
	if err := AppendProfileSkeleton(path, "review"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	if !strings.Contains(text, "# keep me") || !strings.Contains(text, "# inline note") {
		t.Fatalf("comments dropped:\n%s", text)
	}
	if !strings.Contains(text, "    existing:") || !strings.Contains(text, "default_profile: existing") {
		t.Fatalf("existing entries dropped:\n%s", text)
	}
	if !strings.Contains(text, "    review:\n        kind: claude") {
		t.Fatalf("new profile must use the existing 4-space indent:\n%s", text)
	}
	if strings.Contains(text, "\n  review:") {
		t.Fatalf("2-space insert re-anchored the profiles block:\n%s", text)
	}
	cfg, err := ParseConfigText(path, text)
	if err != nil {
		t.Fatalf("result must load: %v", err)
	}
	if _, ok := cfg.Profiles["review"]; !ok {
		t.Fatalf("new profile missing:\n%s", text)
	}
	if p := cfg.Profiles["existing"]; p.Kind != "claude" || len(p.Args) != 1 {
		t.Fatalf("existing profile changed: %+v", p)
	}
	if cfg.DefaultProfile != "existing" {
		t.Fatalf("default_profile = %q", cfg.DefaultProfile)
	}
}

func TestAppendProfileSkeletonRejectsDuplicate(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	original := "profiles:\n  dup:\n    kind: claude\n"
	write(t, path, original)
	err := AppendProfileSkeleton(path, "dup")
	if err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("err = %v", err)
	}
	data, _ := os.ReadFile(path)
	if string(data) != original {
		t.Fatalf("file changed on duplicate:\n%s", data)
	}
}

func TestConfigPathForScope(t *testing.T) {
	plugin, root := fixture(t)
	global, err := ConfigPathForScope("global", root, nil)
	if err != nil || global != filepath.Join(plugin, "config.yaml") {
		t.Fatalf("global = %q err=%v", global, err)
	}
	repo, _ := ConfigPathForScope("repo", root, nil)
	if repo != filepath.Join(root, ".hwf", "config.yaml") {
		t.Fatalf("repo = %q", repo)
	}
	local, _ := ConfigPathForScope("local", root, nil)
	if local != filepath.Join(root, ".hwf", "config.local.yaml") {
		t.Fatalf("local = %q", local)
	}
	if _, err := ConfigPathForScope("bogus", root, nil); err == nil {
		t.Fatal("bogus scope must error")
	}
}
