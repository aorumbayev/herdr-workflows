// Command verify-no-archive fails when openspec/changes/archive holds entries.
// Run from the repository root:
//
//	go run ./scripts/verify-no-archive [root]
//
// When root is omitted, the repository root is two levels above this script.
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
)

// Check returns an exit code and optional stdout/stderr for the archive gate.
func Check(root string) (exitCode int, stdout, stderr string) {
	archiveDir := filepath.Join(root, "openspec", "changes", "archive")
	entries, err := os.ReadDir(archiveDir)
	if err != nil {
		return 0, "", ""
	}
	if len(entries) == 0 {
		return 0, "", ""
	}
	names := make([]string, len(entries))
	for i, e := range entries {
		names[i] = e.Name()
	}
	slices.Sort(names)
	kind := "entries"
	if len(names) == 1 {
		kind = "entry"
	}
	var errOut strings.Builder
	fmt.Fprintf(&errOut, "openspec/changes/archive holds %d %s: %s\n", len(names), kind, strings.Join(names, ", "))
	errOut.WriteString("Main keeps no archived specs — delete the archived contents; the main specs already carry the sync.\n")
	return 1, "", errOut.String()
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
