package main

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunReportsAllIndependentFailures(t *testing.T) {
	var calls []string
	cfg := Config{
		Fast: true,
		Dir:  "/repo",
		LookPath: func(file string) (string, error) {
			return "/bin/" + file, nil
		},
		Command: func(name string, args []string) (string, error) {
			calls = append(calls, name+" "+strings.Join(args, " "))
			switch {
			case name == "gofmt":
				return "", errors.New("format failed")
			case name == "go" && len(args) > 0 && args[0] == "vet":
				return "", errors.New("vet failed")
			case name == "go" && len(args) > 0 && args[0] == "list":
				return "example.com/mod/pkg\nexample.com/mod/e2e\n", nil
			}
			return "", nil
		},
	}
	var stdout, stderr bytes.Buffer
	code := Run(cfg, &stdout, &stderr)
	if code == 0 {
		t.Fatal("expected non-zero exit when checks fail")
	}
	if len(calls) < 2 {
		t.Fatalf("stopped after first failure: calls=%v", calls)
	}
	if !containsCommand(calls, "go run ./scripts/verify-comments") {
		t.Fatalf("did not reach final independent check: calls=%v", calls)
	}
	out := stdout.String() + stderr.String()
	if !strings.Contains(out, "format") {
		t.Fatalf("missing format failure in output: %q", out)
	}
	if !strings.Contains(out, "vet") {
		t.Fatalf("missing vet failure in output: %q", out)
	}
}

func containsCommand(commands []string, want string) bool {
	for _, command := range commands {
		if command == want {
			return true
		}
	}
	return false
}

func TestRunReportsCheckProgress(t *testing.T) {
	cfg := Config{
		Fast: true,
		Dir:  "/repo",
		LookPath: func(file string) (string, error) {
			return "/bin/" + file, nil
		},
		Command: func(name string, args []string) (string, error) {
			if name == "go" && len(args) > 0 && args[0] == "list" {
				return "example.com/mod/pkg\n", nil
			}
			return "", nil
		},
	}
	var stdout, stderr bytes.Buffer
	if code := Run(cfg, &stdout, &stderr); code != 0 {
		t.Fatalf("code = %d stderr = %q", code, stderr.String())
	}
	for _, want := range []string{"verify: format: start", "verify: format: pass"} {
		if !strings.Contains(stdout.String(), want) {
			t.Fatalf("stdout missing %q:\n%s", want, stdout.String())
		}
	}
}

func TestFastOmitsDocsGovulncheckAndE2E(t *testing.T) {
	var cmds []string
	cfg := Config{
		Fast: true,
		Dir:  "/repo",
		LookPath: func(file string) (string, error) {
			return "/bin/" + file, nil
		},
		Command: func(name string, args []string) (string, error) {
			cmds = append(cmds, name+" "+strings.Join(args, " "))
			if name == "go" && len(args) > 0 && args[0] == "list" {
				return "example.com/mod/pkg\nexample.com/mod/e2e\n", nil
			}
			return "", nil
		},
	}
	var stdout, stderr bytes.Buffer
	if code := Run(cfg, &stdout, &stderr); code != 0 {
		t.Fatalf("expected success, got %d stderr=%q", code, stderr.String())
	}
	joined := strings.Join(cmds, "\n")
	for _, forbidden := range []string{"npm", "openspec", "govulncheck"} {
		if strings.Contains(joined, forbidden) {
			t.Fatalf("fast mode must not run %q; cmds:\n%s", forbidden, joined)
		}
	}
	hasRace := false
	for _, c := range cmds {
		if strings.HasPrefix(c, "go test -race ") {
			if strings.Contains(c, "/e2e") || strings.Contains(c, "./...") {
				t.Fatalf("fast race tests must exclude e2e and ./...; got %q", c)
			}
			hasRace = true
		}
	}
	if !hasRace {
		t.Fatalf("fast mode must run race tests excluding e2e; cmds:\n%s", joined)
	}
}

func TestFullIncludesDocsAndAllRaceTests(t *testing.T) {
	dir := t.TempDir()
	var cmds []string
	cfg := Config{
		Fast: false,
		Dir:  dir,
		LookPath: func(file string) (string, error) {
			return "/bin/" + file, nil
		},
		Command: func(name string, args []string) (string, error) {
			cmds = append(cmds, name+" "+strings.Join(args, " "))
			if name == "goreleaser" && len(args) > 0 && args[0] == "release" {
				if err := writeSnapshotArtifacts(dir); err != nil {
					return "", err
				}
			}
			return "", nil
		},
	}
	var stdout, stderr bytes.Buffer
	if code := Run(cfg, &stdout, &stderr); code != 0 {
		t.Fatalf("expected success, got %d stderr=%q", code, stderr.String())
	}
	joined := strings.Join(cmds, "\n")
	want := []string{
		"gofmt -l .",
		"go vet ./...",
		"go test -race ./...",
		"golangci-lint run",
		"go run ./scripts/verify-prose",
		"go run ./scripts/verify-file-length",
		"go run ./scripts/verify-comments",
		"npm ci --prefix docs",
		"npm run build --prefix docs",
		"go tool govulncheck ./...",
		"goreleaser check",
		"goreleaser release --snapshot --clean --skip=publish",
	}
	for _, w := range want {
		if !strings.Contains(joined, w) {
			t.Fatalf("full mode missing %q; cmds:\n%s", w, joined)
		}
	}
	for _, forbidden := range []string{
		"openspec validate --strict --all --no-interactive",
		"go run ./scripts/verify-no-archive",
	} {
		if strings.Contains(joined, forbidden) {
			t.Fatalf("full mode must not run %q; cmds:\n%s", forbidden, joined)
		}
	}
}

func writeSnapshotArtifacts(dir string) error {
	dist := filepath.Join(dir, "dist")
	if err := os.MkdirAll(dist, 0o755); err != nil {
		return err
	}
	version := "0.0.0-SNAPSHOT"
	for _, osName := range []string{"linux", "darwin"} {
		for _, arch := range []string{"amd64", "arm64"} {
			name := "herdr-workflows_" + version + "_" + osName + "_" + arch + ".tar.gz"
			if err := os.WriteFile(filepath.Join(dist, name), []byte("x"), 0o644); err != nil {
				return err
			}
		}
	}
	return os.WriteFile(filepath.Join(dist, "checksums.txt"), []byte("ok"), 0o644)
}

func TestFastOmitsGoreleaser(t *testing.T) {
	var cmds []string
	cfg := Config{
		Fast: true,
		Dir:  "/repo",
		LookPath: func(file string) (string, error) {
			return "/bin/" + file, nil
		},
		Command: func(name string, args []string) (string, error) {
			cmds = append(cmds, name+" "+strings.Join(args, " "))
			if name == "go" && len(args) > 0 && args[0] == "list" {
				return "example.com/mod/pkg\n", nil
			}
			return "", nil
		},
	}
	var stdout, stderr bytes.Buffer
	if code := Run(cfg, &stdout, &stderr); code != 0 {
		t.Fatalf("expected success, got %d stderr=%q", code, stderr.String())
	}
	joined := strings.Join(cmds, "\n")
	if strings.Contains(joined, "goreleaser") {
		t.Fatalf("fast mode must not run goreleaser; cmds:\n%s", joined)
	}
}

func TestFullRequiresGoreleaser(t *testing.T) {
	cfg := Config{
		Fast: false,
		Dir:  t.TempDir(),
		LookPath: func(file string) (string, error) {
			if file == "goreleaser" {
				return "", errors.New("not found")
			}
			return "/bin/" + file, nil
		},
		Command: func(name string, args []string) (string, error) {
			return "", nil
		},
	}
	var stdout, stderr bytes.Buffer
	code := Run(cfg, &stdout, &stderr)
	if code == 0 {
		t.Fatal("full mode must fail when goreleaser is absent")
	}
	if !strings.Contains(stderr.String(), "goreleaser") {
		t.Fatalf("expected goreleaser failure, got %q", stderr.String())
	}
}

func TestFullGoreleaserRequiresSupportedArchives(t *testing.T) {
	dir := t.TempDir()
	var cmds []string
	cfg := Config{
		Fast: false,
		Dir:  dir,
		LookPath: func(file string) (string, error) {
			return "/bin/" + file, nil
		},
		Command: func(name string, args []string) (string, error) {
			cmds = append(cmds, name+" "+strings.Join(args, " "))
			if name == "goreleaser" && len(args) > 0 && args[0] == "release" {
				if err := writeSnapshotArtifacts(dir); err != nil {
					return "", err
				}
			}
			return "", nil
		},
	}
	var stdout, stderr bytes.Buffer
	if code := Run(cfg, &stdout, &stderr); code != 0 {
		t.Fatalf("expected success, got %d stderr=%q", code, stderr.String())
	}
	joined := strings.Join(cmds, "\n")
	if !strings.Contains(joined, "goreleaser check") {
		t.Fatalf("missing goreleaser check; cmds:\n%s", joined)
	}
	if !strings.Contains(joined, "goreleaser release --snapshot --clean --skip=publish") {
		t.Fatalf("missing goreleaser release snapshot; cmds:\n%s", joined)
	}
}

func TestFullGoreleaserFailsWithoutChecksums(t *testing.T) {
	dir := t.TempDir()
	dist := filepath.Join(dir, "dist")
	if err := os.MkdirAll(dist, 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := Config{
		Fast: false,
		Dir:  dir,
		LookPath: func(file string) (string, error) {
			return "/bin/" + file, nil
		},
		Command: func(name string, args []string) (string, error) {
			if name == "goreleaser" && len(args) > 0 && args[0] == "release" {
				for _, pair := range [][2]string{
					{"linux", "amd64"},
					{"linux", "arm64"},
					{"darwin", "amd64"},
					{"darwin", "arm64"},
				} {
					name := "herdr-workflows_0.0.0_" + pair[0] + "_" + pair[1] + ".tar.gz"
					if err := os.WriteFile(filepath.Join(dist, name), []byte("x"), 0o644); err != nil {
						return "", err
					}
				}
			}
			return "", nil
		},
	}
	var stdout, stderr bytes.Buffer
	code := Run(cfg, &stdout, &stderr)
	if code == 0 {
		t.Fatal("expected failure when checksums.txt is missing")
	}
	if !strings.Contains(stderr.String(), "checksums.txt") {
		t.Fatalf("expected checksums.txt failure, got %q", stderr.String())
	}
}

func TestFastSkipsMissingGolangCILint(t *testing.T) {
	cfg := Config{
		Fast: true,
		Dir:  "/repo",
		LookPath: func(file string) (string, error) {
			if file == "golangci-lint" {
				return "", errors.New("not found")
			}
			return "/bin/" + file, nil
		},
		Command: func(name string, args []string) (string, error) {
			if strings.Contains(name, "golangci-lint") {
				t.Fatal("golangci-lint must not run when absent in fast mode")
			}
			if name == "go" && len(args) > 0 && args[0] == "list" {
				return "example.com/mod/pkg\n", nil
			}
			return "", nil
		},
	}
	var stdout, stderr bytes.Buffer
	if code := Run(cfg, &stdout, &stderr); code != 0 {
		t.Fatalf("expected success, got %d stderr=%q", code, stderr.String())
	}
	if !strings.Contains(stderr.String(), "skipping golangci-lint") {
		t.Fatalf("expected skip message, got %q", stderr.String())
	}
}

func TestFullRequiresGolangCILint(t *testing.T) {
	cfg := Config{
		Fast: false,
		Dir:  "/repo",
		LookPath: func(file string) (string, error) {
			if file == "golangci-lint" {
				return "", errors.New("not found")
			}
			return "/bin/" + file, nil
		},
		Command: func(name string, args []string) (string, error) {
			return "", nil
		},
	}
	var stdout, stderr bytes.Buffer
	code := Run(cfg, &stdout, &stderr)
	if code == 0 {
		t.Fatal("full mode must fail when golangci-lint is absent")
	}
	if !strings.Contains(stderr.String(), "golangci-lint") {
		t.Fatalf("expected golangci-lint failure, got %q", stderr.String())
	}
}

func TestParseArgsFast(t *testing.T) {
	fast, err := ParseArgs([]string{"-fast"})
	if err != nil {
		t.Fatal(err)
	}
	if !fast {
		t.Fatal("expected fast=true")
	}
}

func TestParseArgsDefaultFull(t *testing.T) {
	fast, err := ParseArgs(nil)
	if err != nil {
		t.Fatal(err)
	}
	if fast {
		t.Fatal("expected full mode by default")
	}
}

func TestParseArgsUnknownFlag(t *testing.T) {
	_, err := ParseArgs([]string{"--bogus"})
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestExecuteUnknownFlagExitCode(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := Execute([]string{"--bogus"}, &stdout, &stderr)
	if code != 2 {
		t.Fatalf("expected exit 2, got %d", code)
	}
}

func TestFormatFailsWhenGofmtListsFiles(t *testing.T) {
	cfg := Config{
		Fast: true,
		Dir:  "/repo",
		LookPath: func(file string) (string, error) {
			return "/bin/" + file, nil
		},
		Command: func(name string, args []string) (string, error) {
			if name == "gofmt" {
				return "main.go\n", nil
			}
			if name == "go" && len(args) > 0 && args[0] == "list" {
				return "example.com/mod/pkg\n", nil
			}
			return "", nil
		},
	}
	var stdout, stderr bytes.Buffer
	code := Run(cfg, &stdout, &stderr)
	if code == 0 {
		t.Fatal("expected failure when gofmt lists files")
	}
	if !strings.Contains(stderr.String(), "format") {
		t.Fatalf("expected format failure, got %q", stderr.String())
	}
}
