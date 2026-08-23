package cli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/config"
)

func writeExecutable(t *testing.T, path, body string) {
	t.Helper()
	content := "#!/bin/sh\n" + body
	if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
		t.Fatal(err)
	}
}

func writeRecordingHerdr(t *testing.T, dir string) (bin, log string) {
	t.Helper()
	log = filepath.Join(dir, "herdr-argv.log")
	bin = filepath.Join(dir, "fake-herdr")
	writeExecutable(t, bin, `printf '%s\n' "$*" >> "`+log+`"
if [ "$1" = config ] && [ "$2" = check ]; then
  echo "config: ok"
  exit 0
fi
if [ "$1" = server ] && [ "$2" = reload-config ]; then
  exit 0
fi
exit 1
`)
	return bin, log
}

func TestResolveBinDirPrefersXDGBinHome(t *testing.T) {
	custom := filepath.Join(t.TempDir(), "hwf-custom-bin")
	got := ResolveBinDir(func(string) string { return custom })
	if got != custom {
		t.Fatalf("ResolveBinDir() = %q, want %q", got, custom)
	}
}

func TestResolveHerdrConfigPath(t *testing.T) {
	if got := ResolveHerdrConfigPath(func(k string) string {
		if k == "HERDR_CONFIG_PATH" {
			return "/tmp/c.toml"
		}
		return ""
	}); got != "/tmp/c.toml" {
		t.Fatalf("HERDR_CONFIG_PATH = %q", got)
	}
	want := filepath.Join("/xdg", "herdr", "config.toml")
	if got := ResolveHerdrConfigPath(func(k string) string {
		if k == "XDG_CONFIG_HOME" {
			return "/xdg"
		}
		return ""
	}); got != want {
		t.Fatalf("XDG path = %q, want %q", got, want)
	}
}

func TestInstallCliCommandsFreshAndRepeated(t *testing.T) {
	root := t.TempDir()
	binDir := filepath.Join(root, "bin")
	pluginBin := filepath.Join(root, "plugin", "bin")
	if err := os.MkdirAll(pluginBin, 0o755); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(pluginBin, "herdr-workflows")
	if err := os.WriteFile(source, []byte("fake-binary\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	first := InstallCliCommands(binDir, source, false)
	if !messagesContainInstall(first.Messages) {
		t.Fatalf("first messages = %v", first.Messages)
	}
	reg := ReadOwnership(binDir)
	if reg.Entries["herdr-workflows"].Kind != ownedSymlink {
		t.Fatalf("herdr-workflows entry = %+v", reg.Entries["herdr-workflows"])
	}
	if reg.Entries["hwf"].Kind == "" {
		t.Fatal("missing hwf entry")
	}

	if err := os.WriteFile(source, []byte("fake-binary-v2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	second := InstallCliCommands(binDir, source, false)
	if len(second.Messages) == 0 {
		t.Fatal("expected messages on repeat install")
	}
	reg = ReadOwnership(binDir)
	absSource, _ := filepath.Abs(source)
	entry := reg.Entries["herdr-workflows"]
	if entry.Kind != ownedSymlink || entry.Version != config.ProductVersion || entry.Source != absSource {
		t.Fatalf("entry = %+v, want symlink %s %s", entry, config.ProductVersion, absSource)
	}
}

func messagesContainInstall(msgs []string) bool {
	for _, m := range msgs {
		if strings.Contains(m, "install") || strings.Contains(m, "linked") || strings.Contains(m, "copied") {
			return true
		}
	}
	return false
}

func TestInstallCliCommandsPreservesForeignEntry(t *testing.T) {
	root := t.TempDir()
	binDir := filepath.Join(root, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	foreign := filepath.Join(binDir, "herdr-workflows")
	if err := os.WriteFile(foreign, []byte("not-ours\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(root, "source-bin")
	if err := os.WriteFile(source, []byte("ours\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	result := InstallCliCommands(binDir, source, false)
	if !containsMessage(result.Messages, "not owned") {
		t.Fatalf("messages = %v", result.Messages)
	}
	data, err := os.ReadFile(foreign)
	if err != nil || string(data) != "not-ours\n" {
		t.Fatalf("foreign file = %q err=%v", data, err)
	}
}

func TestInstallCliCommandsRetargetedOwnedSymlink(t *testing.T) {
	root := t.TempDir()
	binDir := filepath.Join(root, "bin")
	source := filepath.Join(root, "source-bin")
	foreign := filepath.Join(root, "foreign-bin")
	for _, p := range []struct {
		path, body string
	}{
		{source, "ours\n"},
		{foreign, "foreign\n"},
	} {
		if err := os.WriteFile(p.path, []byte(p.body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	InstallCliCommands(binDir, source, false)
	hwf := filepath.Join(binDir, "hwf")
	if err := os.Remove(hwf); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(foreign, hwf); err != nil {
		t.Fatal(err)
	}
	result := InstallCliCommands(binDir, source, false)
	want := "skipped cli install: " + hwf + " exists and is not owned by herdr-workflows"
	if !containsMessage(result.Messages, want) {
		t.Fatalf("messages = %v", result.Messages)
	}
	data, err := os.ReadFile(hwf)
	if err != nil || string(data) != "foreign\n" {
		t.Fatalf("hwf = %q err=%v", data, err)
	}
}

func TestInstallCliCommandsEphemeralSingleCopy(t *testing.T) {
	root := t.TempDir()
	binDir := filepath.Join(root, "bin")
	pluginBin := filepath.Join(root, "plugin", "bin")
	if err := os.MkdirAll(pluginBin, 0o755); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(pluginBin, "herdr-workflows")
	if err := os.WriteFile(source, []byte("fake-binary\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	InstallCliCommands(binDir, source, true)

	primary := filepath.Join(binDir, "herdr-workflows")
	hwf := filepath.Join(binDir, "hwf")
	pst, err := os.Lstat(primary)
	if err != nil {
		t.Fatal(err)
	}
	if pst.Mode()&os.ModeSymlink != 0 {
		t.Fatal("primary should be a copy, not symlink")
	}
	hst, err := os.Lstat(hwf)
	if err != nil {
		t.Fatal(err)
	}
	if hst.Mode()&os.ModeSymlink == 0 {
		t.Fatal("hwf should be symlink")
	}
	link, err := os.Readlink(hwf)
	if err != nil || link != primary {
		t.Fatalf("hwf link = %q err=%v", link, err)
	}
	data, err := os.ReadFile(hwf)
	if err != nil || string(data) != "fake-binary\n" {
		t.Fatalf("hwf content = %q err=%v", data, err)
	}
	if ReadOwnership(binDir).Entries["hwf"].Kind != ownedSymlink {
		t.Fatal("hwf should be recorded as symlink")
	}
}

func TestInstallCliCommandsEphemeralForeignPrimary(t *testing.T) {
	root := t.TempDir()
	binDir := filepath.Join(root, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(binDir, "herdr-workflows"), []byte("not-ours\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	pluginBin := filepath.Join(root, "plugin", "bin")
	if err := os.MkdirAll(pluginBin, 0o755); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(pluginBin, "herdr-workflows")
	if err := os.WriteFile(source, []byte("fake-binary\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	result := InstallCliCommands(binDir, source, true)
	if !containsMessage(result.Messages, "not owned") {
		t.Fatalf("messages = %v", result.Messages)
	}
	hwf := filepath.Join(binDir, "hwf")
	st, err := os.Lstat(hwf)
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode()&os.ModeSymlink != 0 {
		t.Fatal("hwf should be copied when primary is foreign")
	}
	data, err := os.ReadFile(hwf)
	if err != nil || string(data) != "fake-binary\n" {
		t.Fatalf("hwf = %q err=%v", data, err)
	}
}

func TestInstallCliCommandsEphemeralPreservesForeign(t *testing.T) {
	root := t.TempDir()
	binDir := filepath.Join(root, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	foreignFile := filepath.Join(binDir, "herdr-workflows")
	foreignLink := filepath.Join(binDir, "hwf")
	elsewhere := filepath.Join(root, "foreign-target")
	for _, p := range []struct {
		path, body string
	}{
		{foreignFile, "foreign-file\n"},
		{elsewhere, "foreign-link-target\n"},
	} {
		if err := os.WriteFile(p.path, []byte(p.body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(elsewhere, foreignLink); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(root, "source-bin")
	if err := os.WriteFile(source, []byte("ours\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	result := InstallCliCommands(binDir, source, true)
	notOwned := 0
	for _, m := range result.Messages {
		if strings.Contains(m, "not owned") {
			notOwned++
		}
	}
	if notOwned != 2 {
		t.Fatalf("not owned count = %d, messages = %v", notOwned, result.Messages)
	}
	for _, pair := range []struct {
		path, want string
	}{
		{foreignFile, "foreign-file\n"},
		{foreignLink, "foreign-link-target\n"},
	} {
		data, err := os.ReadFile(pair.path)
		if err != nil || string(data) != pair.want {
			t.Fatalf("%s = %q err=%v", pair.path, data, err)
		}
	}
}

func containsMessage(msgs []string, want string) bool {
	for _, m := range msgs {
		if m == want || strings.Contains(m, want) {
			return true
		}
	}
	return false
}

func TestInstallKeybindingsIdempotent(t *testing.T) {
	dir := t.TempDir()
	herdrBin, logPath := writeRecordingHerdr(t, dir)
	path := filepath.Join(dir, "config.toml")
	if err := os.WriteFile(path, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(logPath, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	getenv := func(k string) string {
		switch k {
		case "HERDR_CONFIG_PATH":
			return path
		case "HERDR_BIN_PATH":
			return herdrBin
		}
		return os.Getenv(k)
	}
	first := InstallKeybindings(KeybindingInstallOpts{Getenv: getenv})
	joined := strings.Join(first.Messages, "\n")
	if !strings.Contains(joined, "herdr-workflows.launch") {
		t.Fatalf("messages = %q", joined)
	}
	text, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	body := string(text)
	for _, want := range []string{"herdr-workflows.launch", `key = "prefix+k"`} {
		if !strings.Contains(body, want) {
			t.Fatalf("config missing %q: %q", want, body)
		}
	}
	if strings.Contains(body, "herdr-workflows.results") {
		t.Fatalf("config should not contain results binding: %q", body)
	}
	log, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	logText := string(log)
	if !strings.Contains(logText, "config check") || !strings.Contains(logText, "server reload-config") {
		t.Fatalf("log = %q", logText)
	}
	if !strings.Contains(joined, "herdr reloaded config") {
		t.Fatalf("messages = %q", joined)
	}

	if err := os.WriteFile(logPath, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	again := InstallKeybindings(KeybindingInstallOpts{Getenv: getenv})
	if !strings.Contains(strings.Join(again.Messages, "\n"), "already present") {
		t.Fatalf("again messages = %v", again.Messages)
	}
	text2, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(text2) != body {
		t.Fatal("config changed on second install")
	}
	if strings.Count(body, "herdr-workflows.launch") != 1 {
		t.Fatalf("launch count = %d", strings.Count(body, "herdr-workflows.launch"))
	}
	log2, err := os.ReadFile(logPath)
	if err != nil || len(log2) != 0 {
		t.Fatalf("log after idempotent = %q err=%v", log2, err)
	}
}

func TestInstallKeybindingsStripsRetired(t *testing.T) {
	dir := t.TempDir()
	herdrBin, logPath := writeRecordingHerdr(t, dir)
	path := filepath.Join(dir, "config.toml")
	stale := `# keep me

[[keys.command]]
key = "prefix+k"
type = "plugin_action"
command = "kagan.launch"
description = "launch a kagan workflow (picker)"

[[keys.command]]
key = "prefix+l"
type = "plugin_action"
command = "lembas.launch"
description = "launch lembas"

[[keys.command]]
key = "prefix+r"
type = "plugin_action"
command = "herdr-workflows.results"
description = "view completed herdr-workflows job results"
`
	if err := os.WriteFile(path, []byte(stale), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(logPath, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	getenv := func(k string) string {
		switch k {
		case "HERDR_CONFIG_PATH":
			return path
		case "HERDR_BIN_PATH":
			return herdrBin
		}
		return os.Getenv(k)
	}
	result := InstallKeybindings(KeybindingInstallOpts{Getenv: getenv})
	if !strings.Contains(strings.Join(result.Messages, "\n"), "removed dead") {
		t.Fatalf("messages = %v", result.Messages)
	}
	text, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	body := string(text)
	for _, forbidden := range []string{"kagan.launch", "lembas.launch", "herdr-workflows.results", "prefix+r"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("config still contains %q: %q", forbidden, body)
		}
	}
	if !strings.Contains(body, "herdr-workflows.launch") {
		t.Fatalf("missing launch binding: %q", body)
	}
	bak, err := os.ReadFile(path + ".hwf.bak")
	if err != nil || string(bak) != stale {
		t.Fatalf("backup = %q err=%v", bak, err)
	}
	again := InstallKeybindings(KeybindingInstallOpts{Getenv: getenv})
	if !strings.Contains(strings.Join(again.Messages, "\n"), "already present") {
		t.Fatalf("again = %v", again.Messages)
	}
	text2, err := os.ReadFile(path)
	if err != nil || string(text2) != body {
		t.Fatal("config changed on repeat")
	}
}

func TestStripDeadBindings(t *testing.T) {
	text := `
[[keys.command]]
command = "keep.me"

[[keys.command]]
command = "herdr-workflows.results"
`
	cleaned := StripDeadBindings(text)
	if !strings.Contains(cleaned, "keep.me") {
		t.Fatalf("cleaned = %q", cleaned)
	}
	if strings.Contains(cleaned, "herdr-workflows.results") {
		t.Fatalf("cleaned = %q", cleaned)
	}
}

func TestInstallKeybindingsMissingValidator(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")
	original := "# keep me\n"
	if err := os.WriteFile(path, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}
	reload := false
	result := InstallKeybindings(KeybindingInstallOpts{
		Getenv: func(k string) string {
			switch k {
			case "HERDR_CONFIG_PATH":
				return path
			case "HERDR_BIN_PATH":
				return filepath.Join(dir, "missing-herdr")
			}
			return os.Getenv(k)
		},
		Reload: &reload,
	})
	if !strings.Contains(strings.Join(result.Messages, "\n"), "config check failed") {
		t.Fatalf("messages = %v", result.Messages)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != original {
		t.Fatalf("config = %q err=%v", data, err)
	}
	if _, err := os.Stat(path + ".hwf.tmp"); !os.IsNotExist(err) {
		t.Fatalf("tmp file should not exist: %v", err)
	}
}

func TestInstallKeybindingsReloadFailure(t *testing.T) {
	dir := t.TempDir()
	log := filepath.Join(dir, "herdr-argv.log")
	herdrBin := filepath.Join(dir, "fake-herdr")
	writeExecutable(t, herdrBin, `printf '%s\n' "$*" >> "`+log+`"
if [ "$1" = config ] && [ "$2" = check ]; then
  echo "config: ok"
  exit 0
fi
if [ "$1" = server ] && [ "$2" = reload-config ]; then
  echo "reload denied" >&2
  exit 3
fi
exit 1
`)
	path := filepath.Join(dir, "config.toml")
	if err := os.WriteFile(path, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	getenv := func(k string) string {
		switch k {
		case "HERDR_CONFIG_PATH":
			return path
		case "HERDR_BIN_PATH":
			return herdrBin
		}
		return os.Getenv(k)
	}
	result := InstallKeybindings(KeybindingInstallOpts{Getenv: getenv})
	joined := strings.Join(result.Messages, "\n")
	for _, want := range []string{"herdr-workflows.launch", "reload-config failed", "may not have loaded the binding"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("messages missing %q: %q", want, joined)
		}
	}
	if strings.Contains(joined, "herdr reloaded config") {
		t.Fatalf("messages = %q", joined)
	}
	body, err := os.ReadFile(path)
	if err != nil || !strings.Contains(string(body), "herdr-workflows.launch") {
		t.Fatalf("config = %q err=%v", body, err)
	}
}

func TestResolveBinDirPathWarningShape(t *testing.T) {
	missing := ResolveBinDir(func(k string) string {
		if k == "XDG_BIN_HOME" {
			return filepath.Join(t.TempDir(), "hwf-missing-bin-xyz")
		}
		return ""
	})
	if !strings.Contains(missing, "hwf-missing-bin-xyz") {
		t.Fatalf("bin dir = %q", missing)
	}
}
