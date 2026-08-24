package contract_test

import (
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func isAllowedTSJSPath(rel string) bool {
	return strings.HasPrefix(rel, "docs/")
}

func isProductTSJSViolation(rel string) bool {
	ext := strings.ToLower(filepath.Ext(rel))
	if ext != ".ts" && ext != ".js" {
		return false
	}
	return !isAllowedTSJSPath(rel)
}

func TestRepoHasNoProductTypeScriptOrJavaScript(t *testing.T) {
	root := repoRoot(t)
	cmd := exec.Command("git", "-C", root, "ls-files", "-z")
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("git ls-files: %v", err)
	}

	var violations []string
	for _, rel := range strings.Split(strings.TrimRight(string(out), "\x00"), "\x00") {
		rel = filepath.ToSlash(rel)
		if rel != "" && isProductTSJSViolation(rel) {
			violations = append(violations, rel)
		}
	}
	if len(violations) > 0 {
		t.Fatalf("unexpected tracked .ts/.js outside allowlist (docs/ only):\n%s", strings.Join(violations, "\n"))
	}
}
