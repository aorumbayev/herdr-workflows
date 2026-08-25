package config

import (
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// ProfileEntry is one merged profile and the layer that effectively defines it.
type ProfileEntry struct {
	Name   string
	Kind   string
	Args   []string
	Source string
	File   string
}

// ListProfiles gives every merged profile with its defining layer and file.
// Source is global, repo, or local: the highest-priority layer that sets it.
func ListProfiles(repoRoot string, getenv Env) ([]ProfileEntry, error) {
	globalPath, err := GlobalConfigPath(getenv)
	if err != nil {
		return nil, err
	}
	layers := []struct{ source, path string }{
		{"global", globalPath},
		{"repo", RepoConfigPath(repoRoot)},
		{"local", RepoLocalConfigPath(repoRoot)},
	}
	type def struct {
		profile      Profile
		source, file string
	}
	defs := map[string]def{}
	for _, layer := range layers {
		cfg, ok, err := loadFile(layer.path)
		if err != nil {
			return nil, err
		}
		if !ok {
			continue
		}
		for name, p := range cfg.Profiles {
			defs[name] = def{profile: p, source: layer.source, file: layer.path}
		}
	}
	out := make([]ProfileEntry, 0, len(defs))
	for _, name := range slices.Sorted(maps.Keys(defs)) {
		d := defs[name]
		out = append(out, ProfileEntry{Name: name, Kind: d.profile.Kind, Args: d.profile.Args, Source: d.source, File: d.file})
	}
	return out, nil
}

// ConfigPathForScope maps a scope name to its layer file path.
func ConfigPathForScope(scope, repoRoot string, getenv Env) (string, error) {
	switch scope {
	case "global":
		return GlobalConfigPath(getenv)
	case "repo":
		return RepoConfigPath(repoRoot), nil
	case "local":
		return RepoLocalConfigPath(repoRoot), nil
	default:
		return "", &LoadError{msg: "unknown profile scope " + scope}
	}
}

const profilesFileHeader = "# herdr-workflows profiles. Set kind, and add args if the agent needs them.\n"

func profileSkeletonEntry(name string) string {
	return "  " + name + ":\n" +
		"    kind: claude # native agent kind; add an args list below if needed\n"
}

// AppendProfileSkeleton adds a minimal profile named name to the config file at
// path without dropping existing comments or entries. It creates the file when
// absent, rejects a duplicate name, and refuses to write a file that would not load.
func AppendProfileSkeleton(path, name string) error {
	if !ProfileNameRE.MatchString(name) {
		return &LoadError{msg: positioned(path, "profiles."+name, "profile name must match [a-z][a-z0-9_-]{0,31}")}
	}
	data, err := os.ReadFile(path)
	switch {
	case err == nil:
		return appendProfileToExisting(path, string(data), name)
	case os.IsNotExist(err):
		return createConfigWithProfile(path, name)
	default:
		return &LoadError{msg: positioned(path, "", err.Error())}
	}
}

func createConfigWithProfile(path, name string) error {
	text := profilesFileHeader + "profiles:\n" + profileSkeletonEntry(name)
	if _, err := ParseConfigText(path, text); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return &LoadError{msg: positioned(path, "", err.Error())}
	}
	return os.WriteFile(path, []byte(text), 0o644)
}

func appendProfileToExisting(path, existing, name string) error {
	cfg, err := ParseConfigText(path, existing)
	if err != nil {
		return err
	}
	if _, dup := cfg.Profiles[name]; dup {
		return &LoadError{msg: positioned(path, "profiles."+name, "profile already exists")}
	}
	updated := insertProfileEntry(existing, name)
	if _, err := ParseConfigText(path, updated); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(updated), 0o644)
}

// insertProfileEntry puts the skeleton entry under an existing profiles: block as
// its first child, or appends a new profiles: block when none is present.
func insertProfileEntry(existing, name string) string {
	entry := strings.Split(strings.TrimRight(profileSkeletonEntry(name), "\n"), "\n")
	lines := strings.Split(existing, "\n")
	for i, line := range lines {
		if strings.TrimRight(line, " \t") != "profiles:" {
			continue
		}
		merged := append([]string{}, lines[:i+1]...)
		merged = append(merged, entry...)
		merged = append(merged, lines[i+1:]...)
		return strings.Join(merged, "\n")
	}
	block := "profiles:\n" + profileSkeletonEntry(name)
	if existing == "" {
		return block
	}
	if strings.HasSuffix(existing, "\n") {
		return existing + block
	}
	return existing + "\n" + block
}
