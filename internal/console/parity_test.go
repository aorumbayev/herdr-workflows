package console

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

var testFuncDecl = regexp.MustCompile(`(?m)^func (Test\w+)\(`)

func loadPackageTestFuncs(dirs ...string) map[string]struct{} {
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

func coveringTestExists(name string, own map[string]struct{}, external map[string]map[string]struct{}) bool {
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

func TestParityBaselineCoversConsoleScenarios(t *testing.T) {
	ownTests := loadPackageTestFuncs(".")
	externalTests := map[string]map[string]struct{}{
		"tui":      loadPackageTestFuncs("../tui"),
		"picker":   loadPackageTestFuncs("../picker"),
		"workflow": loadPackageTestFuncs("../workflow"),
		"cli":      loadPackageTestFuncs("../cli"),
	}
	rows := ParityBaseline()
	if len(rows) < 6 {
		t.Fatalf("ParityBaseline rows = %d, want at least 6", len(rows))
	}
	for _, row := range rows {
		if row.Spec == "" || row.CoveringTest == "" || row.GoSurface == "" {
			t.Fatalf("incomplete row: %+v", row)
		}
		if !coveringTestExists(row.CoveringTest, ownTests, externalTests) {
			t.Fatalf("scenario %q CoveringTest %q does not exist", row.Scenario, row.CoveringTest)
		}
	}
}
