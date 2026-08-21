package contract_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func isAllowedTSJSPath(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return false
	}
	rel = filepath.ToSlash(rel)

	if strings.HasPrefix(rel, "docs/") {
		return true
	}
	// Product browser asset. .ts outside docs/ is never allowed.
	if rel == "embed/field-model.js" {
		return true
	}
	return false
}

func shouldSkipDir(name string) bool {
	switch name {
	case ".git", "node_modules":
		return true
	default:
		return false
	}
}

func TestRepoHasNoProductTypeScriptOrJavaScript(t *testing.T) {
	root := repoRoot(t)
	var violations []string

	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return walkDirDecision(root, path, d.Name())
		}
		if isProductTSJSViolation(root, path) {
			rel, relErr := filepath.Rel(root, path)
			if relErr != nil {
				violations = append(violations, path)
			} else {
				violations = append(violations, filepath.ToSlash(rel))
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(violations) > 0 {
		t.Fatalf("unexpected .ts/.js outside allowlist (docs/ or embed/field-model.js):\n%s", strings.Join(violations, "\n"))
	}
}

func walkDirDecision(root, path, name string) error {
	if shouldSkipDir(name) {
		return filepath.SkipDir
	}
	if path == root {
		return nil
	}
	rel, err := filepath.Rel(root, path)
	if err == nil && strings.HasPrefix(filepath.ToSlash(rel), "docs/") {
		return filepath.SkipDir
	}
	return nil
}

func isProductTSJSViolation(root, path string) bool {
	ext := strings.ToLower(filepath.Ext(path))
	if ext != ".ts" && ext != ".js" {
		return false
	}
	return !isAllowedTSJSPath(root, path)
}
