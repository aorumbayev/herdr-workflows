package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/host"
	"github.com/spf13/cobra"
)

const ownershipFile = ".herdr-workflows-cli.json"

type ownedKind string

const (
	ownedSymlink ownedKind = "symlink"
	ownedCopy    ownedKind = "copy"
)

// OwnershipEntry records one installed CLI name in binDir.
type OwnershipEntry struct {
	Kind    ownedKind `json:"kind"`
	Version string    `json:"version"`
	Source  string    `json:"source,omitempty"`
}

// OwnershipRegistry is the install record for binDir.
type OwnershipRegistry struct {
	Version string                    `json:"version"`
	Entries map[string]OwnershipEntry `json:"entries"`
}

// InstallResult reports install messages from InstallCliCommands.
type InstallResult struct {
	Messages []string
}

// KeybindingInstallResult reports keybinding install messages.
type KeybindingInstallResult struct {
	Messages []string
	Path     string
}

// ResolveBinDir uses XDG_BIN_HOME when that value is set. When it is empty, ResolveBinDir uses ~/.local/bin.
func ResolveBinDir(getenv func(string) string) string {
	if getenv == nil {
		getenv = os.Getenv
	}
	if custom := strings.TrimSpace(getenv("XDG_BIN_HOME")); custom != "" {
		return custom
	}
	home, err := config.HomeDir(getenv)
	if err != nil {
		return filepath.Join(".", ".local", "bin")
	}
	return filepath.Join(home, ".local", "bin")
}

// ResolveHerdrConfigPath uses HERDR_CONFIG_PATH when that value is set. When it is empty, ResolveHerdrConfigPath uses XDG/herdr/config.toml.
func ResolveHerdrConfigPath(getenv func(string) string) string {
	if getenv == nil {
		getenv = os.Getenv
	}
	if custom := strings.TrimSpace(getenv("HERDR_CONFIG_PATH")); custom != "" {
		return custom
	}
	base := filepath.Join(".config", "herdr")
	if xdg := strings.TrimSpace(getenv("XDG_CONFIG_HOME")); xdg != "" {
		base = filepath.Join(xdg, "herdr")
	} else if home, err := config.HomeDir(getenv); err == nil {
		base = filepath.Join(home, ".config", "herdr")
	}
	return filepath.Join(base, "config.toml")
}

func resolvePluginRoot(getenv func(string) string, execPath, cwd string) string {
	if getenv == nil {
		getenv = os.Getenv
	}
	if injected := strings.TrimSpace(getenv("HERDR_PLUGIN_ROOT")); injected != "" {
		abs, err := filepath.Abs(injected)
		if err == nil {
			return abs
		}
		return injected
	}
	base := strings.ToLower(filepath.Base(execPath))
	if base == "herdr-workflows" || base == "hwf" {
		parent := filepath.Dir(execPath)
		if strings.ToLower(filepath.Base(parent)) == "bin" {
			abs, err := filepath.Abs(filepath.Dir(parent))
			if err == nil {
				return abs
			}
		}
	}
	if cwd == "" {
		cwd, _ = os.Getwd()
	}
	abs, err := filepath.Abs(cwd)
	if err != nil {
		return cwd
	}
	return abs
}

func resolveManagedBinary(pluginRoot string) string {
	bare := filepath.Join(pluginRoot, "bin", "herdr-workflows")
	if st, err := os.Stat(bare); err == nil && !st.IsDir() {
		return bare
	}
	return ""
}

func isEphemeralPluginRoot(pluginRoot string) bool {
	for _, part := range strings.Split(filepath.Clean(pluginRoot), string(os.PathSeparator)) {
		if strings.HasPrefix(part, ".tmp-install-") {
			return true
		}
	}
	return false
}

func binDirOnPath(dir string, getenv func(string) string) bool {
	if getenv == nil {
		getenv = os.Getenv
	}
	pathEnv := getenv("PATH")
	absDir, err := filepath.Abs(dir)
	if err != nil {
		absDir = dir
	}
	for _, entry := range filepath.SplitList(pathEnv) {
		if entry == "" {
			continue
		}
		absEntry, err := filepath.Abs(entry)
		if err != nil {
			absEntry = entry
		}
		if absEntry == absDir {
			return true
		}
	}
	return false
}

func ownershipPath(binDir string) string {
	return filepath.Join(binDir, ownershipFile)
}

// ReadOwnership reads the install record for binDir.
func ReadOwnership(binDir string) OwnershipRegistry {
	data, err := os.ReadFile(ownershipPath(binDir))
	if err != nil {
		return OwnershipRegistry{Version: config.ProductVersion, Entries: map[string]OwnershipEntry{}}
	}
	var raw OwnershipRegistry
	if err := json.Unmarshal(data, &raw); err != nil || raw.Entries == nil {
		return OwnershipRegistry{Version: config.ProductVersion, Entries: map[string]OwnershipEntry{}}
	}
	if raw.Version == "" {
		raw.Version = config.ProductVersion
	}
	return raw
}

func writeOwnership(binDir string, registry OwnershipRegistry) error {
	registry.Version = config.ProductVersion
	data, err := json.MarshalIndent(registry, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(ownershipPath(binDir), append(data, '\n'), 0o644)
}

func entryExists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

func mark(registry *OwnershipRegistry, name string, kind ownedKind, source string) {
	if registry.Entries == nil {
		registry.Entries = map[string]OwnershipEntry{}
	}
	abs, _ := filepath.Abs(source)
	registry.Entries[name] = OwnershipEntry{
		Kind:    kind,
		Version: config.ProductVersion,
		Source:  abs,
	}
}

func installPosixName(dir, name, source string, kind ownedKind, registry *OwnershipRegistry, messages *[]string) string {
	dest := filepath.Join(dir, name)
	entry := registry.Entries[name]

	if entryExists(dest) {
		if out, done := handleExistingInstall(dest, entry, kind, source, messages); done {
			return out
		}
	}

	absSource, _ := filepath.Abs(source)
	if kind == ownedCopy {
		if err := copyFile(absSource, dest); err != nil {
			*messages = append(*messages, fmt.Sprintf("skipped cli install: %s: %v", dest, err))
			return ""
		}
		_ = os.Chmod(dest, 0o755)
		mark(registry, name, ownedCopy, absSource)
		*messages = append(*messages, fmt.Sprintf("copied %s → %s", absSource, dest))
		return dest
	}

	if err := os.Symlink(absSource, dest); err != nil {
		if err := copyFile(absSource, dest); err != nil {
			*messages = append(*messages, fmt.Sprintf("skipped cli install: %s: %v", dest, err))
			return ""
		}
		_ = os.Chmod(dest, 0o755)
		mark(registry, name, ownedCopy, absSource)
		*messages = append(*messages, fmt.Sprintf("copied %s → %s (symlink unavailable)", absSource, dest))
		return dest
	}
	mark(registry, name, ownedSymlink, absSource)
	*messages = append(*messages, fmt.Sprintf("linked %s → %s", absSource, dest))
	return dest
}

func handleExistingInstall(dest string, entry OwnershipEntry, kind ownedKind, source string, messages *[]string) (string, bool) {
	st, err := os.Lstat(dest)
	if err != nil {
		*messages = append(*messages, fmt.Sprintf("skipped cli install: %s exists and is not owned by herdr-workflows", dest))
		return "", true
	}
	absSource, _ := filepath.Abs(source)
	name := filepath.Base(dest)
	if st.Mode()&os.ModeSymlink != 0 {
		linkDest, err := os.Readlink(dest)
		if err != nil {
			*messages = append(*messages, fmt.Sprintf("skipped cli install: %s exists and is not owned by herdr-workflows", dest))
			return "", true
		}
		resolvedLink, _ := filepath.Abs(filepath.Join(filepath.Dir(dest), linkDest))
		owned := entry.Kind == ownedSymlink && entry.Source != "" && resolvedLink == entry.Source
		if kind == ownedSymlink && resolvedLink == absSource && owned {
			*messages = append(*messages, fmt.Sprintf("%s already linked at %s", name, dest))
			return dest, true
		}
		if !owned {
			*messages = append(*messages, fmt.Sprintf("skipped cli install: %s exists and is not owned by herdr-workflows", dest))
			return "", true
		}
		_ = os.Remove(dest)
		return "", false
	}
	if entry.Kind == ownedCopy {
		_ = os.Remove(dest)
		return "", false
	}
	*messages = append(*messages, fmt.Sprintf("skipped cli install: %s exists and is not owned by herdr-workflows", dest))
	return "", true
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer func() { _ = in.Close() }()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	defer func() { _ = out.Close() }()
	_, err = io.Copy(out, in)
	return err
}

// InstallCliCommands installs herdr-workflows and hwf into binDir.
func InstallCliCommands(binDir, binary string, ephemeral bool) InstallResult {
	messages := []string{}
	_ = os.MkdirAll(binDir, 0o755)
	registry := ReadOwnership(binDir)

	primaryKind := ownedSymlink
	if ephemeral {
		primaryKind = ownedCopy
	}
	primary := installPosixName(binDir, "herdr-workflows", binary, primaryKind, &registry, &messages)

	hwfSource := binary
	hwfKind := primaryKind
	if ephemeral && primary != "" {
		hwfSource = primary
		hwfKind = ownedSymlink
	} else if ephemeral {
		hwfKind = ownedCopy
	}
	installPosixName(binDir, "hwf", hwfSource, hwfKind, &registry, &messages)

	_ = writeOwnership(binDir, registry)
	return InstallResult{Messages: messages}
}

var deadActions = map[string]struct{}{
	"kagan.launch": {}, "kagan.results": {}, "kagan.reconcile": {}, "kagan.confirm": {}, "kagan.flag": {},
	"lembas.launch": {}, "lembas.results": {}, "lembas.reconcile": {}, "lembas.confirm": {}, "lembas.flag": {},
	"herdr-workflows.results": {}, "herdr-workflows.reconcile": {}, "herdr-workflows.confirm": {}, "herdr-workflows.flag": {},
}

var launchBinding = `
[[keys.command]]
key = "prefix+k"
type = "plugin_action"
command = "herdr-workflows.launch"
description = "launch a herdr-workflows workflow (picker)"
`

// StripDeadBindings removes complete [[keys.command]] tables for actions that are no longer in use.
func StripDeadBindings(text string) string {
	parts := strings.Split(text, "[[keys.command]]")
	if len(parts) == 1 {
		return text
	}
	out := parts[0]
	for i := 1; i < len(parts); i++ {
		body := parts[i]
		command := ""
		for _, line := range strings.Split(body, "\n") {
			trimmed := strings.TrimSpace(line)
			if !strings.HasPrefix(trimmed, "command") {
				continue
			}
			if idx := strings.Index(trimmed, `"`); idx >= 0 {
				rest := trimmed[idx+1:]
				if end := strings.Index(rest, `"`); end >= 0 {
					command = rest[:end]
					break
				}
			}
		}
		if command != "" {
			if _, dead := deadActions[command]; dead {
				continue
			}
		}
		out += "[[keys.command]]" + body
	}
	return out
}

func derefString(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func mergeEnv(getenv func(string) string, extra map[string]string) []string {
	if getenv == nil {
		getenv = os.Getenv
	}
	base := map[string]string{}
	for _, entry := range os.Environ() {
		key, val, ok := strings.Cut(entry, "=")
		if ok {
			base[key] = val
		}
	}
	for key, val := range extra {
		base[key] = val
	}
	overlayGetenv(base, getenv, extra)
	out := make([]string, 0, len(base))
	for key, val := range base {
		out = append(out, key+"="+val)
	}
	return out
}

func overlayGetenv(base map[string]string, getenv func(string) string, extra map[string]string) {
	if getenv == nil {
		return
	}
	for _, key := range []string{"HERDR_BIN_PATH", "HERDR_CONFIG_PATH", "PATH", "HOME", "XDG_CONFIG_HOME"} {
		if extra != nil {
			if _, ok := extra[key]; ok {
				continue
			}
		}
		if v := getenv(key); v != "" {
			base[key] = v
		}
	}
}

func spawnHerdr(args []string, getenv func(string) string, extra map[string]string) (stdout, stderr string, exitCode int, runErr error) {
	bin := host.BinPath(getenv)
	cmd := exec.Command(bin, args...)
	cmd.Env = mergeEnv(getenv, extra)
	var outBuf, errBuf strings.Builder
	cmd.Stdout = &outBuf
	cmd.Stderr = &errBuf
	err := cmd.Run()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return outBuf.String(), errBuf.String(), exitErr.ExitCode(), nil
		}
		return outBuf.String(), errBuf.String(), -1, err
	}
	return outBuf.String(), errBuf.String(), 0, nil
}

func validates(candidate string, getenv func(string) string) (bool, string) {
	stdout, stderr, _, runErr := spawnHerdr([]string{"config", "check"}, getenv, map[string]string{
		"HERDR_CONFIG_PATH": candidate,
	})
	if runErr != nil {
		return false, runErr.Error()
	}
	out := stdout + stderr
	return strings.Contains(out, "config: ok"), out
}

// KeybindingInstallOpts sets the options for InstallKeybindings.
type KeybindingInstallOpts struct {
	Getenv func(string) string
	Reload *bool
}

// InstallKeybindings adds the prefix+k launch binding and removes tables for actions that are no longer in use.
func InstallKeybindings(opts KeybindingInstallOpts) KeybindingInstallResult {
	getenv := opts.Getenv
	if getenv == nil {
		getenv = os.Getenv
	}
	path := ResolveHerdrConfigPath(getenv)
	messages := []string{}

	var original *string
	if data, err := os.ReadFile(path); err == nil {
		s := string(data)
		original = &s
	}
	var cleaned *string
	if original != nil {
		s := StripDeadBindings(*original)
		cleaned = &s
	}

	missing := cleaned == nil || !strings.Contains(derefString(cleaned), "herdr-workflows.launch")
	if !missing && cleaned != nil && original != nil && *cleaned == *original {
		messages = append(messages, "herdr-workflows keybindings already present; skipping")
		return KeybindingInstallResult{Messages: messages, Path: path}
	}

	_ = os.MkdirAll(filepath.Dir(path), 0o755)
	prefix := ""
	if cleaned != nil && *cleaned != "" && !strings.HasSuffix(*cleaned, "\n") {
		prefix = "\n"
	}
	next := ""
	if cleaned != nil {
		next = *cleaned
	}
	if missing {
		next += prefix + launchBinding
	}

	tmp := path + ".hwf.tmp"
	if err := os.WriteFile(tmp, []byte(next), 0o644); err != nil {
		messages = append(messages, fmt.Sprintf("herdr-workflows keybinding install skipped — write failed: %v", err))
		return KeybindingInstallResult{Messages: messages, Path: path}
	}
	ok, out := validates(tmp, getenv)
	if !ok {
		_ = os.Remove(tmp)
		messages = append(messages, "herdr-workflows keybinding install skipped — herdr config check failed:")
		trimmed := strings.TrimSpace(out)
		if trimmed == "" {
			trimmed = "(no output)"
		}
		messages = append(messages, trimmed)
		return KeybindingInstallResult{Messages: messages, Path: path}
	}

	if original != nil {
		_ = os.WriteFile(path+".hwf.bak", []byte(*original), 0o644)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		messages = append(messages, fmt.Sprintf("herdr-workflows keybinding install skipped — rename failed: %v", err))
		return KeybindingInstallResult{Messages: messages, Path: path}
	}

	parts := []string{}
	if missing {
		parts = append(parts, "added herdr-workflows.launch")
	}
	if original != nil && cleaned != nil && *cleaned != *original {
		parts = append(parts, "removed dead herdr-workflows.* bindings")
	}
	suffix := ""
	if original != nil {
		suffix = " (backup: config.toml.hwf.bak)"
	}
	messages = append(messages, fmt.Sprintf("%s in %s%s", strings.Join(parts, "; "), path, suffix))

	reload := true
	if opts.Reload != nil {
		reload = *opts.Reload
	}
	if reload {
		appendReloadMessage(&messages, getenv, path)
	}
	return KeybindingInstallResult{Messages: messages, Path: path}
}

func appendReloadMessage(messages *[]string, getenv func(string) string, path string) {
	stdout, stderr, code, runErr := spawnHerdr([]string{"server", "reload-config"}, getenv, nil)
	if runErr == nil && code == 0 {
		*messages = append(*messages, fmt.Sprintf("herdr reloaded config so the running server reads %s", path))
		return
	}
	*messages = append(*messages, fmt.Sprintf(
		"herdr server reload-config failed (%s) — wrote %s but the running Herdr may not have loaded the binding yet",
		reloadFailureDetail(stdout, stderr, code, runErr), path))
}

func reloadFailureDetail(stdout, stderr string, code int, runErr error) string {
	if runErr != nil {
		return runErr.Error()
	}
	if detail := strings.TrimSpace(stderr + stdout); detail != "" {
		return detail
	}
	return fmt.Sprintf("exit %d", code)
}

func runSetup(cmd *cobra.Command, _ []string) error {
	log := func(line string) { _, _ = fmt.Fprintln(cmd.OutOrStdout(), line) }
	if err := setupInstall(log); err != nil {
		log(fmt.Sprintf("skipped setup: %v", err))
	}
	return nil
}

func setupInstall(log func(string)) error {
	getenv := os.Getenv
	binDir := ResolveBinDir(getenv)
	execPath, err := os.Executable()
	if err != nil {
		execPath = os.Args[0]
	}
	cwd, _ := os.Getwd()
	pluginRoot := resolvePluginRoot(getenv, execPath, cwd)
	binary := resolveManagedBinary(pluginRoot)
	if binary == "" {
		log(fmt.Sprintf("skipped cli install: managed binary not found under %s (run build first)", pluginRoot))
	} else {
		result := InstallCliCommands(binDir, binary, isEphemeralPluginRoot(pluginRoot))
		for _, line := range result.Messages {
			log(line)
		}
	}

	if !binDirOnPath(binDir, getenv) {
		log(fmt.Sprintf("warning: %s is not on PATH — add it to your shell profile", binDir))
	}

	keys := InstallKeybindings(KeybindingInstallOpts{Getenv: getenv})
	for _, line := range keys.Messages {
		log(line)
	}
	return nil
}
