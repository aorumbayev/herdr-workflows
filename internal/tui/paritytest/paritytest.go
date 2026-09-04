// Package paritytest checks that every Parity Baseline row names a real test function.
package paritytest

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var testFuncDecl = regexp.MustCompile(`(?m)^func (Test\w+)\(`)

// TestFuncs collects Test* function names from the _test.go files in dirs.
func TestFuncs(dirs ...string) map[string]struct{} {
	out := make(map[string]struct{})
	for _, dir := range dirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(e.Name(), "_test.go") {
				continue
			}
			data, err := os.ReadFile(filepath.Join(dir, e.Name()))
			if err != nil {
				continue
			}
			for _, m := range testFuncDecl.FindAllSubmatch(data, -1) {
				out[string(m[1])] = struct{}{}
			}
		}
	}
	return out
}

// Covered reports whether name (bare or "pkg.TestX") exists in own or external.
func Covered(name string, own map[string]struct{}, external map[string]map[string]struct{}) bool {
	if pkg, fn, ok := strings.Cut(name, "."); ok {
		funcs, found := external[pkg]
		if !found {
			return false
		}
		_, ok := funcs[fn]
		return ok
	}
	_, ok := own[name]
	return ok
}
