// Command verify-file-length fails when Go sources exceed 2500 lines.
// Run from the repository root:
//
//	go run ./scripts/verify-file-length [root]
package main

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
)

const maxLines = 2500

type finding struct {
	file  string
	lines int
}

// Check scans Go sources under root and returns an exit code with output.
func Check(root string) (exitCode int, stdout, stderr string) {
	var findings []finding
	scan := func(abs string) {
		lines, err := countLines(abs)
		if err != nil {
			fmt.Fprintf(os.Stderr, "read %s: %v\n", abs, err)
			findings = append(findings, finding{file: rel(root, abs), lines: maxLines + 1})
			return
		}
		if lines > maxLines {
			findings = append(findings, finding{file: rel(root, abs), lines: lines})
		}
	}

	mainPath := filepath.Join(root, "main.go")
	if info, err := os.Stat(mainPath); err == nil && !info.IsDir() {
		scan(mainPath)
	}

	for _, dir := range []string{"internal", "embed", "e2e", "scripts"} {
		base := filepath.Join(root, dir)
		_ = filepath.WalkDir(base, func(path string, d os.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if d.IsDir() {
				return nil
			}
			if !strings.HasSuffix(path, ".go") {
				return nil
			}
			if strings.HasSuffix(path, ".gen.go") {
				return nil
			}
			scan(path)
			return nil
		})
	}

	if len(findings) == 0 {
		return 0, fmt.Sprintf("file-length: Go sources under %d lines (*.gen.go exempt)\n", maxLines), ""
	}

	slices.SortFunc(findings, func(a, b finding) int {
		if a.lines != b.lines {
			return b.lines - a.lines
		}
		return strings.Compare(a.file, b.file)
	})

	var out strings.Builder
	for _, f := range findings {
		fmt.Fprintf(&out, "%s: %d lines (max %d)\n", f.file, f.lines, maxLines)
	}
	n := len(findings)
	word := "files"
	if n == 1 {
		word = "file"
	}
	fmt.Fprintf(&out, "\nfile-length: %d %s over %d lines\n", n, word, maxLines)
	return 1, out.String(), ""
}

func rel(root, abs string) string {
	p, err := filepath.Rel(root, abs)
	if err != nil {
		return filepath.ToSlash(abs)
	}
	return filepath.ToSlash(p)
}

func countLines(path string) (int, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer func() { _ = f.Close() }()
	n := 0
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		n++
	}
	return n, sc.Err()
}

func defaultRepoRoot() string {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		wd, _ := os.Getwd()
		return wd
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", ".."))
}

func repoRoot() string {
	if len(os.Args) > 1 {
		return os.Args[1]
	}
	return defaultRepoRoot()
}

func main() {
	code, stdout, stderr := Check(repoRoot())
	if stdout != "" {
		fmt.Print(stdout)
	}
	if stderr != "" {
		fmt.Fprint(os.Stderr, stderr)
	}
	os.Exit(code)
}
