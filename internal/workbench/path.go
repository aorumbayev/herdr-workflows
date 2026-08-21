package workbench

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/aorumbayev/herdr-workflows/internal/config"
)

func trustedWorkflowBase(scope, repoRoot string) (string, error) {
	if scope == "repo" {
		return filepath.Abs(repoRoot)
	}
	return config.HomeDir(os.Getenv)
}

func pathInsideRoot(file, root string) bool {
	return file == root || strings.HasPrefix(file, root+string(filepath.Separator))
}

func shortPath(path string) string {
	home, err := config.HomeDir(os.Getenv)
	if err != nil {
		return path
	}
	if path == home {
		return "~"
	}
	prefix := home + string(filepath.Separator)
	if strings.HasPrefix(path, prefix) {
		return "~" + path[len(home):]
	}
	return path
}

func refuseUnsafeWorkflowPath(file, trustedBase, label string, rootLabel ...string) *saveResult {
	root := "workflow root"
	if len(rootLabel) > 0 && rootLabel[0] != "" {
		root = rootLabel[0]
	}
	absBase, err := filepath.Abs(trustedBase)
	if err != nil {
		return saveErr(500, err.Error())
	}
	absFile, err := filepath.Abs(file)
	if err != nil {
		return saveErr(500, err.Error())
	}
	rel, err := filepath.Rel(absBase, absFile)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return saveErr(400, "refusing path outside "+root+" for "+label)
	}
	realBase := absBase
	if resolved, err := filepath.EvalSymlinks(absBase); err == nil {
		realBase = resolved
	}
	segments := strings.Split(rel, string(filepath.Separator))
	cur := absBase
	for i, seg := range segments {
		if seg == "" {
			continue
		}
		cur = filepath.Join(cur, seg)
		st, err := os.Lstat(cur)
		if err != nil {
			if !os.IsNotExist(err) {
				return saveErr(500, err.Error())
			}
			return refuseAbsentPath(cur, realBase, root, label)
		}
		if st.Mode()&os.ModeSymlink != 0 {
			if i == len(segments)-1 {
				return saveErr(400, "refusing symlinked workflow '"+label+"'")
			}
			if seg == "workflows" {
				return saveErr(400, "refusing symlinked workflow root for "+label)
			}
			return saveErr(400, "refusing symlinked path component for "+label)
		}
	}
	realFile, err := filepath.EvalSymlinks(absFile)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return saveErr(500, err.Error())
	}
	if !pathInsideRoot(realFile, realBase) {
		return saveErr(400, "refusing path outside "+root+" for "+label)
	}
	return nil
}

func refuseAbsentPath(cur, realBase, root, label string) *saveResult {
	parent := filepath.Dir(cur)
	realParent, parentErr := filepath.EvalSymlinks(parent)
	if parentErr != nil {
		realParent = parent
	}
	if !pathInsideRoot(realParent, realBase) {
		return saveErr(400, "refusing path outside "+root+" for "+label)
	}
	return nil
}
