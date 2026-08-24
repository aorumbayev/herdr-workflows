// Package config loads the layered plugin configuration (profiles,
// default_profile, transcripts) and resolves the invocation context.
// The name avoids a collision with the standard library context package.
package config

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/aorumbayev/herdr-workflows/internal/host"
)

// ProfileNameRE is the identifier rule for profile names and default_profile.
var ProfileNameRE = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`)

// Profile maps a name to a native herdr agent kind plus optional args.
type Profile struct {
	Kind string
	Args []string
}

// TranscriptExtractor is a direct argv command keyed by native agent kind.
type TranscriptExtractor struct {
	Command []string
}

// Config is the merged view of all configuration layers. An empty
// DefaultProfile means no layer declared one.
type Config struct {
	Profiles       map[string]Profile
	DefaultProfile string
	Transcripts    map[string]TranscriptExtractor
}

// LoadError names the file and key behind a configuration failure.
type LoadError struct {
	msg string
}

func (e *LoadError) Error() string { return e.msg }

func positioned(file, key, message string) string {
	if key != "" {
		return fmt.Sprintf("%s, %s: %s", file, key, message)
	}
	return fmt.Sprintf("%s: %s", file, message)
}

type rawProfile struct {
	Kind string   `yaml:"kind"`
	Args []string `yaml:"args"`
}

type rawTranscript struct {
	Command []string `yaml:"command"`
}

type rawConfig struct {
	Profiles       map[string]rawProfile    `yaml:"profiles"`
	DefaultProfile *string                  `yaml:"default_profile"`
	Transcripts    map[string]rawTranscript `yaml:"transcripts"`
}

var unknownFieldRE = regexp.MustCompile(`field (\S+) not found`)

func emptyConfig() Config {
	return Config{Profiles: map[string]Profile{}, Transcripts: map[string]TranscriptExtractor{}}
}

func decodeError(file string, err error) *LoadError {
	var typeErr *yaml.TypeError
	if !errors.As(err, &typeErr) {
		return &LoadError{msg: positioned(file, "", err.Error())}
	}
	msgs := make([]string, 0, len(typeErr.Errors))
	for _, e := range typeErr.Errors {
		if m := unknownFieldRE.FindStringSubmatch(e); m != nil {
			msgs = append(msgs, positioned(file, m[1], fmt.Sprintf("Unrecognized key: %q", m[1])))
			continue
		}
		msgs = append(msgs, positioned(file, "", e))
	}
	return &LoadError{msg: strings.Join(msgs, "; ")}
}

// ParseConfigText validates a config YAML buffer through the same schema
// LoadConfig uses.
func ParseConfigText(file, text string) (Config, error) {
	var raw rawConfig
	dec := yaml.NewDecoder(strings.NewReader(text))
	dec.KnownFields(true)
	if err := dec.Decode(&raw); err != nil {
		if errors.Is(err, io.EOF) {
			return emptyConfig(), nil
		}
		return Config{}, decodeError(file, err)
	}
	var extra yaml.Node
	switch err := dec.Decode(&extra); {
	case err == nil:
		return Config{}, &LoadError{msg: positioned(file, "", "expected a single YAML document")}
	case !errors.Is(err, io.EOF):
		return Config{}, decodeError(file, err)
	}
	cfg := emptyConfig()
	for _, name := range slices.Sorted(maps.Keys(raw.Profiles)) {
		p := raw.Profiles[name]
		if !ProfileNameRE.MatchString(name) {
			return Config{}, &LoadError{msg: positioned(file, "profiles."+name, "profile name must match [a-z][a-z0-9_-]{0,31}")}
		}
		if p.Kind == "" {
			return Config{}, &LoadError{msg: positioned(file, "profiles."+name+".kind", "kind must be a non-empty string")}
		}
		if p.Args != nil {
			if len(p.Args) == 0 {
				return Config{}, &LoadError{msg: positioned(file, "profiles."+name+".args", "args must be a non-empty list of non-empty strings")}
			}
			for _, a := range p.Args {
				if a == "" {
					return Config{}, &LoadError{msg: positioned(file, "profiles."+name+".args", "args must be a non-empty list of non-empty strings")}
				}
			}
		}
		cfg.Profiles[name] = Profile(p)
	}
	if raw.DefaultProfile != nil {
		if !ProfileNameRE.MatchString(*raw.DefaultProfile) {
			return Config{}, &LoadError{msg: positioned(file, "default_profile", "default_profile must match [a-z][a-z0-9_-]{0,31}")}
		}
		cfg.DefaultProfile = *raw.DefaultProfile
	}
	for _, kind := range slices.Sorted(maps.Keys(raw.Transcripts)) {
		tr := raw.Transcripts[kind]
		if kind == "" {
			return Config{}, &LoadError{msg: positioned(file, "transcripts", "transcript kind must be a non-empty string")}
		}
		if len(tr.Command) == 0 {
			return Config{}, &LoadError{msg: positioned(file, "transcripts."+kind+".command", "command must be a non-empty list of non-empty strings")}
		}
		for _, c := range tr.Command {
			if c == "" {
				return Config{}, &LoadError{msg: positioned(file, "transcripts."+kind+".command", "command must be a non-empty list of non-empty strings")}
			}
		}
		cfg.Transcripts[kind] = TranscriptExtractor(tr)
	}
	return cfg, nil
}

func loadFile(file string) (Config, bool, error) {
	data, err := os.ReadFile(file)
	if err != nil {
		if os.IsNotExist(err) {
			return Config{}, false, nil
		}
		return Config{}, false, &LoadError{msg: positioned(file, "", err.Error())}
	}
	cfg, err := ParseConfigText(file, string(data))
	if err != nil {
		return Config{}, false, err
	}
	return cfg, true, nil
}

const pluginID = "herdr-workflows"

// Env reads an environment variable; nil means os.Getenv.
type Env func(string) string

func envOr(getenv Env) Env {
	if getenv == nil {
		return os.Getenv
	}
	return getenv
}

// ResolvePluginConfigDir resolves the herdr-owned plugin config directory
// (never ~/.hwf).
func ResolvePluginConfigDir(getenv Env) (string, error) {
	env := envOr(getenv)
	if injected := strings.TrimSpace(env("HERDR_PLUGIN_CONFIG_DIR")); injected != "" {
		return injected, nil
	}
	bin := host.BinPath(env)
	cmd := exec.Command(bin, "plugin", "config-dir", pluginID)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	runErr := cmd.Run()
	dir := strings.TrimSpace(stdout.String())
	if runErr != nil || dir == "" {
		reason := strings.TrimSpace(stderr.String())
		if reason == "" {
			var exitErr *exec.ExitError
			switch {
			case errors.As(runErr, &exitErr):
				reason = fmt.Sprintf("exit %d", exitErr.ExitCode())
			case runErr != nil:
				reason = runErr.Error()
			default:
				reason = "exit 0 with empty output"
			}
		}
		return "", &LoadError{msg: fmt.Sprintf(
			"failed to discover plugin config directory via '%s plugin config-dir %s': %s",
			bin, pluginID, reason)}
	}
	return dir, nil
}

// GlobalConfigPath is the global layer: $HERDR_PLUGIN_CONFIG_DIR/config.yaml.
func GlobalConfigPath(getenv Env) (string, error) {
	dir, err := ResolvePluginConfigDir(getenv)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "config.yaml"), nil
}

// PluginStateDir is the herdr-owned plugin state directory for run logs,
// managed responses, and transcripts.
func PluginStateDir(getenv Env) (string, error) {
	if dir := envOr(getenv)("HERDR_PLUGIN_STATE_DIR"); dir != "" {
		return dir, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", &LoadError{msg: fmt.Sprintf("cannot resolve the home directory for the plugin state directory: %s", err)}
	}
	return filepath.Join(home, ".hwf", "state"), nil
}

// HomeDir resolves the invoking user's home directory through the injected
// environment seam: $HOME when set, else the OS home.
func HomeDir(getenv Env) (string, error) {
	env := envOr(getenv)
	if home := env("HOME"); home != "" {
		return home, nil
	}
	return os.UserHomeDir()
}

// RepoConfigPath is the committed layer: <repoRoot>/.hwf/config.yaml.
func RepoConfigPath(repoRoot string) string {
	return filepath.Join(repoRoot, ".hwf", "config.yaml")
}

// RepoLocalConfigPath is the gitignored layer: <repoRoot>/.hwf/config.local.yaml.
func RepoLocalConfigPath(repoRoot string) string {
	return filepath.Join(repoRoot, ".hwf", "config.local.yaml")
}

// EnsureLocalConfigGitignored makes sure .hwf/.gitignore covers local config
// and tmp before the first write.
func EnsureLocalConfigGitignored(repoRoot string) error {
	hwfDir := filepath.Join(repoRoot, ".hwf")
	ignorePath := filepath.Join(hwfDir, ".gitignore")
	markers := []string{filepath.Base(RepoLocalConfigPath(repoRoot)), "tmp/"}
	data, err := os.ReadFile(ignorePath)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	text := string(data)
	lines := map[string]bool{}
	for _, line := range strings.FieldsFunc(text, func(r rune) bool { return r == '\n' || r == '\r' }) {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			lines[trimmed] = true
		}
	}
	changed := false
	for _, marker := range markers {
		if lines[marker] {
			continue
		}
		if len(text) > 0 && !strings.HasSuffix(text, "\n") {
			text += "\n"
		}
		text += marker + "\n"
		changed = true
	}
	if changed || os.IsNotExist(err) {
		if mkErr := os.MkdirAll(hwfDir, 0o755); mkErr != nil {
			return mkErr
		}
		return os.WriteFile(ignorePath, []byte(text), 0o644)
	}
	return nil
}

// mergeLayer applies layer over into; higher precedence replaces whole
// entries by name.
func mergeLayer(into *Config, layer Config) {
	for name, profile := range layer.Profiles {
		into.Profiles[name] = profile
	}
	for kind, extractor := range layer.Transcripts {
		into.Transcripts[kind] = extractor
	}
	if layer.DefaultProfile != "" {
		into.DefaultProfile = layer.DefaultProfile
	}
}

// LoadConfig merges global → committed repo → local; higher precedence
// replaces whole entries by name.
func LoadConfig(repoRoot string, getenv Env) (Config, error) {
	merged := emptyConfig()
	globalPath, err := GlobalConfigPath(getenv)
	if err != nil {
		return Config{}, err
	}
	repoPath := RepoConfigPath(repoRoot)
	localPath := RepoLocalConfigPath(repoRoot)
	defaultProfileFile := ""
	for _, path := range []string{globalPath, repoPath, localPath} {
		cfg, ok, err := loadFile(path)
		if err != nil {
			return Config{}, err
		}
		if !ok {
			continue
		}
		mergeLayer(&merged, cfg)
		if cfg.DefaultProfile != "" {
			defaultProfileFile = path
		}
	}
	if merged.DefaultProfile != "" {
		if _, ok := merged.Profiles[merged.DefaultProfile]; !ok {
			if defaultProfileFile == "" {
				defaultProfileFile = repoPath
			}
			return Config{}, &LoadError{msg: positioned(defaultProfileFile, "default_profile",
				fmt.Sprintf("default_profile '%s' is not a merged profile", merged.DefaultProfile))}
		}
	}
	return merged, nil
}

// ProfileNames lists merged profile names in deterministic order.
func ProfileNames(config Config) []string {
	return slices.Sorted(maps.Keys(config.Profiles))
}

// PathsHint is the shared hint naming where configuration was sought.
func PathsHint(globalPath, repoPath string) string {
	return fmt.Sprintf("looked in %s and %s", globalPath, repoPath)
}

// NoProfilesConfiguredMessage points at init when no profile exists.
func NoProfilesConfiguredMessage(globalPath, repoPath string) string {
	return fmt.Sprintf("no profiles configured (%s); run `hwf init` or `hwf init --global`",
		PathsHint(globalPath, repoPath))
}

// ResolveProfile returns the merged profile for name, if any.
func ResolveProfile(config Config, name string) (Profile, bool) {
	p, ok := config.Profiles[name]
	return p, ok
}
