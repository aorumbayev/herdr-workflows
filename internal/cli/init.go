package cli

import (
	"encoding/json"
	"fmt"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

// HerdrAgentKinds lists kinds herdr agent start --kind accepts (herdr 0.8.0).
var HerdrAgentKinds = []string{
	"pi", "claude", "codex", "gemini", "cursor", "devin", "agy", "cline", "omp",
	"mastracode", "opencode", "copilot", "kimi", "kiro", "droid", "amp", "grok",
	"hermes", "kilo", "qodercli", "maki",
}

var knownKinds = []struct {
	name string
	bin  string
}{
	{name: "claude", bin: "claude"},
	{name: "codex", bin: "codex"},
	{name: "cursor", bin: "cursor"},
	{name: "opencode", bin: "opencode"},
	{name: "grok", bin: "grok"},
	{name: "agy", bin: "agy"},
}

type lookPath func(string) (string, error)

func detectProfiles(lookup lookPath) map[string]config.Profile {
	if lookup == nil {
		lookup = exec.LookPath
	}
	profiles := map[string]config.Profile{}
	for _, kind := range knownKinds {
		if !config.ProfileNameRE.MatchString(kind.name) {
			continue
		}
		if _, err := lookup(kind.bin); err != nil {
			continue
		}
		profiles[kind.name] = config.Profile{Kind: kind.name}
	}
	return profiles
}

// ProfilesYAMLInput is the shape written by FormatProfilesYaml.
type ProfilesYAMLInput struct {
	Profiles       map[string]config.Profile
	DefaultProfile string
	Transcripts    map[string]config.TranscriptExtractor
}

// FormatProfilesYaml renders profiles/default_profile/transcripts config YAML.
func FormatProfilesYaml(in ProfilesYAMLInput) string {
	lines := []string{"profiles:"}
	names := slices.Sorted(maps.Keys(in.Profiles))
	if len(names) == 0 {
		lines = append(lines, "  {}")
	} else {
		for _, name := range names {
			profile := in.Profiles[name]
			lines = append(lines, fmt.Sprintf("  %s:", name))
			lines = append(lines, fmt.Sprintf(`    kind: %s`, jsonString(profile.Kind)))
			if len(profile.Args) > 0 {
				args := make([]string, len(profile.Args))
				for i, a := range profile.Args {
					args[i] = jsonString(a)
				}
				lines = append(lines, fmt.Sprintf("    args: [%s]", strings.Join(args, ", ")))
			}
		}
	}
	if in.DefaultProfile != "" {
		lines = append(lines, fmt.Sprintf("default_profile: %s", jsonString(in.DefaultProfile)))
	}
	if len(in.Transcripts) > 0 {
		lines = append(lines, "transcripts:")
		for _, kind := range slices.Sorted(maps.Keys(in.Transcripts)) {
			command := in.Transcripts[kind].Command
			parts := make([]string, len(command))
			for i, a := range command {
				parts[i] = jsonString(a)
			}
			lines = append(lines, fmt.Sprintf("  %s:", kind))
			lines = append(lines, fmt.Sprintf("    command: [%s]", strings.Join(parts, ", ")))
		}
	}
	return strings.Join(lines, "\n") + "\n"
}

func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// InitSeams exposes init helpers for tests without widening the CLI surface.
var InitSeams = struct {
	HerdrAgentKinds    []string
	DetectProfiles     func() map[string]config.Profile
	FormatProfilesYaml func(ProfilesYAMLInput) string
}{
	HerdrAgentKinds:    HerdrAgentKinds,
	DetectProfiles:     func() map[string]config.Profile { return detectProfiles(nil) },
	FormatProfilesYaml: FormatProfilesYaml,
}

// InitOpts configures RunInit.
type InitOpts struct {
	Force    bool
	Global   bool
	Confirm  func() (bool, error)
	Env      config.Env
	LookPath lookPath
}

// InitResult reports what RunInit did.
type InitResult struct {
	Kind     string // wrote, exists, overwritten
	Path     string
	Profiles []string
}

// RunInit writes repo or global plugin config with detected profiles.
func RunInit(repoRoot string, opts InitOpts) (InitResult, error) {
	getenv := opts.Env
	if getenv == nil {
		getenv = os.Getenv
	}
	var path string
	var err error
	if opts.Global {
		path, err = config.GlobalConfigPath(getenv)
		if err != nil {
			return InitResult{}, err
		}
	} else {
		path = config.RepoConfigPath(repoRoot)
	}
	existed := fileExists(path)
	if existed && !opts.Force {
		if opts.Confirm == nil {
			return InitResult{Kind: "exists", Path: path}, nil
		}
		ok, err := opts.Confirm()
		if err != nil {
			return InitResult{}, err
		}
		if !ok {
			return InitResult{Kind: "exists", Path: path}, nil
		}
	}

	profiles := detectProfiles(opts.LookPath)
	names := slices.Sorted(maps.Keys(profiles))

	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return InitResult{}, err
	}
	if !opts.Global {
		if err := os.MkdirAll(filepath.Join(repoRoot, ".hwf", "workflows"), 0o755); err != nil {
			return InitResult{}, err
		}
		if err := config.EnsureLocalConfigGitignored(repoRoot); err != nil {
			return InitResult{}, err
		}
	}

	transcripts := map[string]config.TranscriptExtractor{}
	if existed {
		transcripts = readPreservedTranscripts(path)
	}
	defaultProfile := ""
	if len(names) > 0 {
		defaultProfile = names[0]
	}
	text := FormatProfilesYaml(ProfilesYAMLInput{
		Profiles:       profiles,
		DefaultProfile: defaultProfile,
		Transcripts:    transcripts,
	})
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		return InitResult{}, err
	}
	if existed {
		return InitResult{Kind: "overwritten", Path: path, Profiles: names}, nil
	}
	return InitResult{Kind: "wrote", Path: path, Profiles: names}, nil
}

func readPreservedTranscripts(path string) map[string]config.TranscriptExtractor {
	data, err := os.ReadFile(path)
	if err != nil {
		return map[string]config.TranscriptExtractor{}
	}
	cfg, err := config.ParseConfigText(path, string(data))
	if err != nil {
		return map[string]config.TranscriptExtractor{}
	}
	return cfg.Transcripts
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func runInitCmd(cmd *cobra.Command, _ []string) error {
	force, _ := cmd.Flags().GetBool("force")
	global, _ := cmd.Flags().GetBool("global")

	repoRoot := os.Getenv("HERDR_WORKFLOWS_REPO_ROOT")
	if repoRoot == "" {
		cwd, err := os.Getwd()
		if err != nil {
			return err
		}
		repoRoot = config.ResolveRepoRoot(cwd)
	}

	stdinTTY := false
	if f, ok := cmd.InOrStdin().(*os.File); ok {
		stdinTTY = term.IsTerminal(int(f.Fd()))
	}
	prompted := false
	result, err := RunInit(repoRoot, InitOpts{
		Force:  force,
		Global: global,
		Confirm: func() (bool, error) {
			if !stdinTTY {
				return false, nil
			}
			prompted = true
			label := ".hwf/config.yaml"
			if global {
				label = "global plugin config"
			}
			_, _ = fmt.Fprintf(cmd.OutOrStdout(), "%s exists — overwrite? [y/N] ", label)
			line, err := ReadLine()
			if err != nil {
				return false, err
			}
			return line.Kind == "line" && strings.EqualFold(strings.TrimSpace(line.Text), "y"), nil
		},
	})
	if err != nil {
		return err
	}
	if prompted {
		ReleaseStdinReader()
	}
	if result.Kind == "exists" {
		return fmt.Errorf("%s already exists (pass --force to overwrite)", result.Path)
	}
	profiles := " (no agent kinds on PATH)"
	if len(result.Profiles) > 0 {
		profiles = fmt.Sprintf(" (%s)", strings.Join(result.Profiles, ", "))
	}
	_, _ = fmt.Fprintf(cmd.OutOrStdout(), "wrote %s%s\n", result.Path, profiles)
	if global {
		_, _ = fmt.Fprint(cmd.OutOrStdout(), "profiles apply to every repo; keep personal workflows in ~/.hwf/workflows\n")
	} else {
		_, _ = fmt.Fprintf(cmd.OutOrStdout(),
			"no workflows yet — pick ready-made ones at %s\n"+
				"each card copies an `hwf workflow import` command you can paste here\n",
			config.ExamplesURL)
	}
	return nil
}
