package picker

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/tui"
)

func profileEnv(t *testing.T) (config.Env, string) {
	t.Helper()
	plugin := t.TempDir()
	return func(key string) string {
		if key == "HERDR_PLUGIN_CONFIG_DIR" {
			return plugin
		}
		return ""
	}, plugin
}

func toProfiles(m Model) Model {
	return apply(m, "tab", "tab")
}

func TestProfilesTabListsProfilesWithSourceColumn(t *testing.T) {
	env, plugin := profileEnv(t)
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".hwf"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(plugin, "config.yaml"), []byte("profiles:\n  reviewer:\n    kind: claude\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".hwf", "config.yaml"), []byte("profiles:\n  builder:\n    kind: codex\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	m := toProfiles(New(Options{Entries: catalogEntries(), Width: 80, RepoRoot: root, Env: env}))
	if m.mode != modeProfiles {
		t.Fatalf("mode = %v, want profiles", m.mode)
	}
	body := m.View().Content
	for _, want := range []string{"reviewer", "builder", "global", "repo", tui.FilterProfiles} {
		if !strings.Contains(body, want) {
			t.Fatalf("profiles body missing %q:\n%s", want, body)
		}
	}
}

func TestProfilesBrowserFiltersByTypedText(t *testing.T) {
	env, _ := profileEnv(t)
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".hwf"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".hwf", "config.yaml"),
		[]byte("profiles:\n  reviewer:\n    kind: claude\n  builder:\n    kind: codex\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	m := toProfiles(New(Options{Entries: catalogEntries(), Width: 80, RepoRoot: root, Env: env}))
	m = apply(m, "b", "u", "i")
	list := m.filteredProfiles()
	if len(list) != 1 || list[0].Name != "builder" {
		t.Fatalf("filter builder = %+v", list)
	}
	body := m.View().Content
	if !strings.Contains(body, "builder") || strings.Contains(body, "reviewer") {
		t.Fatalf("filtered body wrong:\n%s", body)
	}
}

func TestProfilesEmptyStatePointsToPalette(t *testing.T) {
	env, _ := profileEnv(t)
	root := t.TempDir()
	m := toProfiles(New(Options{Entries: catalogEntries(), Width: 80, RepoRoot: root, Env: env}))
	body := m.View().Content
	if !strings.Contains(body, tui.ProfilesEmptyMessage) {
		t.Fatalf("empty profiles must guide to the palette:\n%s", body)
	}
}

func TestNewProfileWritesSkeletonToChosenScope(t *testing.T) {
	env, _ := profileEnv(t)
	root := t.TempDir()
	var edited string
	m := toProfiles(New(Options{
		Entries:    catalogEntries(),
		Width:      80,
		RepoRoot:   root,
		Env:        env,
		EditConfig: func(path string) error { edited = path; return nil },
	}))
	m = apply(m, "ctrl+p", "n", "i", "n", "t", "a", "k", "e", "enter")
	if m.mode != modeNewProfileScope {
		t.Fatalf("mode = %v, want scope chooser", m.mode)
	}
	m = apply(m, "down", "enter")
	repoPath := filepath.Join(root, ".hwf", "config.yaml")
	data, err := os.ReadFile(repoPath)
	if err != nil {
		t.Fatalf("repo config missing: %v", err)
	}
	cfg, err := config.ParseConfigText(repoPath, string(data))
	if err != nil {
		t.Fatalf("written config must load: %v", err)
	}
	if _, ok := cfg.Profiles["intake"]; !ok {
		t.Fatalf("skeleton profile missing:\n%s", data)
	}
	if m.mode != modeEditPlace || !m.editProfile {
		t.Fatalf("must open the editor placement chooser for the profile, mode=%v editProfile=%v", m.mode, m.editProfile)
	}
	m = apply(m, "enter")
	if edited != repoPath {
		t.Fatalf("editor opened %q, want %q", edited, repoPath)
	}
	if !strings.Contains(m.status, "validated intake") {
		t.Fatalf("status = %q, want config validation", m.status)
	}
}

func TestNewProfileRejectsDuplicate(t *testing.T) {
	env, _ := profileEnv(t)
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".hwf"), 0o755); err != nil {
		t.Fatal(err)
	}
	repoPath := filepath.Join(root, ".hwf", "config.yaml")
	original := "profiles:\n  intake:\n    kind: claude\n"
	if err := os.WriteFile(repoPath, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}
	m := toProfiles(New(Options{Entries: catalogEntries(), Width: 80, RepoRoot: root, Env: env}))
	m = apply(m, "ctrl+p", "n", "i", "n", "t", "a", "k", "e", "enter", "down", "enter")
	if m.mode != modeProfiles {
		t.Fatalf("duplicate must return to the profiles list, mode=%v", m.mode)
	}
	if !strings.Contains(m.status, "already exists") {
		t.Fatalf("status = %q, want duplicate rejection", m.status)
	}
	data, _ := os.ReadFile(repoPath)
	if string(data) != original {
		t.Fatalf("duplicate must not rewrite the file:\n%s", data)
	}
}

func TestOpenProfileOpensDefiningFileViaPlacementChooser(t *testing.T) {
	env, plugin := profileEnv(t)
	root := t.TempDir()
	globalPath := filepath.Join(plugin, "config.yaml")
	if err := os.WriteFile(globalPath, []byte("profiles:\n  reviewer:\n    kind: claude\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	var edited string
	m := toProfiles(New(Options{
		Entries:    catalogEntries(),
		Width:      80,
		RepoRoot:   root,
		Env:        env,
		EditConfig: func(path string) error { edited = path; return nil },
	}))
	m = apply(m, "enter")
	if m.mode != modeEditPlace || !m.editProfile {
		t.Fatalf("enter must open the placement chooser, mode=%v editProfile=%v", m.mode, m.editProfile)
	}
	m = apply(m, "enter")
	if edited != globalPath {
		t.Fatalf("opened %q, want the defining file %q", edited, globalPath)
	}
	if !strings.Contains(m.status, "validated reviewer") {
		t.Fatalf("status = %q", m.status)
	}
}

func TestNewProfilePopupResizesAndCarriesProfileKind(t *testing.T) {
	env, _ := profileEnv(t)
	root := t.TempDir()
	var states []PopupState
	m := toProfiles(New(Options{
		Entries:     catalogEntries(),
		Width:       80,
		RepoRoot:    root,
		Env:         env,
		EditConfig:  func(string) error { t.Fatal("compact popup must not run the editor"); return nil },
		ReopenPopup: func(state PopupState) error { states = append(states, state); return nil },
	}))
	m = apply(m, "ctrl+p", "n", "d", "e", "v", "enter", "down", "enter", "enter")
	if !m.quit {
		t.Fatal("popup placement must quit the compact popup")
	}
	if len(states) != 1 {
		t.Fatalf("states = %+v", states)
	}
	if states[0].Width != expandedWidth || states[0].Height != expandedHeight {
		t.Fatalf("profile edit popup must open expanded: %+v", states[0])
	}
	if states[0].EditKind != editKindProfile || states[0].Tab != tui.TabProfiles {
		t.Fatalf("popup state must mark the profile edit: %+v", states[0])
	}
	if states[0].EditFile != filepath.Join(root, ".hwf", "config.yaml") {
		t.Fatalf("edit target = %q", states[0].EditFile)
	}
}
