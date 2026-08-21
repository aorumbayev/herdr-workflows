// Command verify runs repository checks for `go tool verify`.
//
//	go run ./scripts/verify [-fast]
package main

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Config controls a verify run. Tests inject LookPath and Command.
type Config struct {
	Fast     bool
	Dir      string
	Stdout   io.Writer
	Stderr   io.Writer
	LookPath func(file string) (string, error)
	Command  func(name string, args []string) (stdout string, err error)
}

type check struct {
	name string
	run  func(cfg Config) error
}

// Run executes independent checks, continues after failures, and returns
// non-zero when any check failed.
func Run(cfg Config, stdout, stderr io.Writer) int {
	if cfg.Dir == "" {
		dir, err := findRepoRoot()
		if err != nil {
			_, _ = fmt.Fprintln(stderr, err)
			return 1
		}
		cfg.Dir = dir
	}
	cfg.Stdout = stdout
	cfg.Stderr = stderr
	if cfg.LookPath == nil {
		cfg.LookPath = exec.LookPath
	}
	if cfg.Command == nil {
		cfg.Command = defaultCommand(cfg)
	}

	failed := 0
	for _, c := range checks(cfg) {
		_, _ = fmt.Fprintf(stdout, "verify: %s: start\n", c.name)
		if err := c.run(cfg); err != nil {
			failed++
			_, _ = fmt.Fprintf(stderr, "verify: %s: %v\n", c.name, err)
			continue
		}
		_, _ = fmt.Fprintf(stdout, "verify: %s: pass\n", c.name)
	}
	if failed > 0 {
		return 1
	}
	return 0
}

func defaultCommand(cfg Config) func(name string, args []string) (string, error) {
	return func(name string, args []string) (string, error) {
		cmd := exec.Command(name, args...)
		cmd.Dir = cfg.Dir
		if name == "npm" && len(args) >= 2 && args[0] == "run" && args[1] == "build" {
			cmd.Env = append(os.Environ(), "CI=1")
		}
		var buf bytes.Buffer
		cmd.Stdout = io.MultiWriter(cfg.Stdout, &buf)
		cmd.Stderr = cfg.Stderr
		err := cmd.Run()
		return buf.String(), err
	}
}

func checks(cfg Config) []check {
	out := []check{
		{name: "format", run: runFormat},
		{name: "vet", run: runVet},
		{name: "test", run: runTest},
		{name: "golangci-lint", run: runGolangCILint},
		{name: "verify-prose", run: runGoScript("verify-prose")},
		{name: "verify-no-archive", run: runGoScript("verify-no-archive")},
		{name: "verify-file-length", run: runGoScript("verify-file-length")},
		{name: "verify-comments", run: runGoScript("verify-comments")},
	}
	if !cfg.Fast {
		out = append(out,
			check{name: "docs", run: runDocs},
			check{name: "openspec", run: runOpenSpec},
			check{name: "govulncheck", run: runGovulncheck},
			check{name: "goreleaser", run: runGoreleaser},
		)
	}
	return out
}

func runFormat(cfg Config) error {
	out, err := cfg.Command("gofmt", []string{"-l", "."})
	if err != nil {
		return err
	}
	if strings.TrimSpace(out) != "" {
		return fmt.Errorf("unformatted files:\n%s", strings.TrimSpace(out))
	}
	return nil
}

func runVet(cfg Config) error {
	_, err := cfg.Command("go", []string{"vet", "./..."})
	return err
}

func runTest(cfg Config) error {
	if cfg.Fast {
		pkgs, err := listPackagesExcludingE2E(cfg)
		if err != nil {
			return err
		}
		args := append([]string{"test", "-race"}, pkgs...)
		_, err = cfg.Command("go", args)
		return err
	}
	_, err := cfg.Command("go", []string{"test", "-race", "./..."})
	return err
}

func listPackagesExcludingE2E(cfg Config) ([]string, error) {
	out, err := cfg.Command("go", []string{"list", "./..."})
	if err != nil {
		return nil, err
	}
	var pkgs []string
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" || strings.HasSuffix(line, "/e2e") {
			continue
		}
		pkgs = append(pkgs, line)
	}
	if len(pkgs) == 0 {
		return nil, fmt.Errorf("no packages")
	}
	return pkgs, nil
}

func runGolangCILint(cfg Config) error {
	if _, err := cfg.LookPath("golangci-lint"); err != nil {
		if cfg.Fast {
			_, _ = fmt.Fprintln(cfg.Stderr, "verify: skipping golangci-lint (not on PATH)")
			return nil
		}
		return fmt.Errorf("golangci-lint not found")
	}
	_, err := cfg.Command("golangci-lint", []string{"run"})
	return err
}

func runGoScript(script string) func(Config) error {
	return func(cfg Config) error {
		_, err := cfg.Command("go", []string{"run", "./scripts/" + script})
		return err
	}
}

func runDocs(cfg Config) error {
	if _, err := cfg.Command("npm", []string{"ci", "--prefix", "docs"}); err != nil {
		return err
	}
	_, err := cfg.Command("npm", []string{"run", "build", "--prefix", "docs"})
	return err
}

func runOpenSpec(cfg Config) error {
	_, err := cfg.Command("openspec", []string{"validate", "--strict", "--all", "--no-interactive"})
	return err
}

func runGovulncheck(cfg Config) error {
	_, err := cfg.Command("go", []string{"tool", "govulncheck", "./..."})
	return err
}

func runGoreleaser(cfg Config) error {
	if _, err := cfg.LookPath("goreleaser"); err != nil {
		return fmt.Errorf("goreleaser not found")
	}
	if _, err := cfg.Command("goreleaser", []string{"check"}); err != nil {
		return err
	}
	if _, err := cfg.Command("goreleaser", []string{"release", "--snapshot", "--clean", "--skip=publish"}); err != nil {
		return err
	}
	return assertSupportedArtifacts(filepath.Join(cfg.Dir, "dist"))
}

func assertSupportedArtifacts(dist string) error {
	entries, err := os.ReadDir(dist)
	if err != nil {
		return fmt.Errorf("dist: %w", err)
	}
	names := make(map[string]bool, len(entries))
	for _, e := range entries {
		names[e.Name()] = true
	}
	if !names["checksums.txt"] {
		return fmt.Errorf("missing checksums.txt")
	}
	wantSuffixes := []string{
		"_linux_amd64.tar.gz",
		"_linux_arm64.tar.gz",
		"_darwin_amd64.tar.gz",
		"_darwin_arm64.tar.gz",
	}
	for _, suffix := range wantSuffixes {
		found := false
		for name := range names {
			if strings.HasPrefix(name, "herdr-workflows_") && strings.HasSuffix(name, suffix) {
				found = true
				break
			}
		}
		if !found {
			return fmt.Errorf("missing herdr-workflows_* %s archive", suffix)
		}
	}
	for name := range names {
		if strings.Contains(name, "windows") {
			return fmt.Errorf("unexpected windows archive %s", name)
		}
	}
	return nil
}

func findRepoRoot() (string, error) {
	wd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for dir := filepath.Clean(wd); ; dir = filepath.Dir(dir) {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("verify: no go.mod above %s", wd)
		}
	}
}

var errHelp = fmt.Errorf("help")

// ParseArgs parses verify CLI flags. Full mode is the default.
func ParseArgs(args []string) (fast bool, err error) {
	for _, a := range args {
		switch a {
		case "-fast":
			fast = true
		case "-h", "--help":
			return false, errHelp
		default:
			return false, fmt.Errorf("verify: unknown flag %s", a)
		}
	}
	return fast, nil
}

// Execute is the public CLI entry point for `go tool verify`.
func Execute(args []string, stdout, stderr io.Writer) int {
	fast, err := ParseArgs(args)
	if err == errHelp {
		_, _ = fmt.Fprintln(stdout, "usage: verify [-fast]")
		return 0
	}
	if err != nil {
		_, _ = fmt.Fprintln(stderr, err)
		return 2
	}
	return Run(Config{Fast: fast}, stdout, stderr)
}

func main() {
	os.Exit(Execute(os.Args[1:], os.Stdout, os.Stderr))
}
