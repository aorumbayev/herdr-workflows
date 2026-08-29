// Package reporoot locates the repository root for scripts.
package reporoot

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

// Find walks up from the working directory to the nearest go.mod,
// falling back to the checkout that compiled this package.
func Find() (string, error) {
	wd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for dir := filepath.Clean(wd); ; dir = filepath.Dir(dir) {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir, nil
		}
		if parent := filepath.Dir(dir); parent == dir {
			break
		}
	}
	if _, file, _, ok := runtime.Caller(0); ok {
		root := filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", ".."))
		if _, err := os.Stat(filepath.Join(root, "go.mod")); err == nil {
			return root, nil
		}
	}
	return "", fmt.Errorf("reporoot: no go.mod above %s", wd)
}
