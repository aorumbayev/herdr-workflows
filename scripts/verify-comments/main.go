// Command verify-comments fails when interior Go comment blocks exceed two lines.
// Run from the repository root:
//
//	go run ./scripts/verify-comments [root]
package main

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
)

const successMsg = "comments: Go sources clean (godoc and context: exempt; interior blocks ≤2 lines)\n"

type finding struct {
	file string
	line int
}

// Check scans Go sources under root for long interior comment blocks.
func Check(root string) (exitCode int, stdout, stderr string) {
	paths, err := goFiles(root)
	if err != nil {
		return 1, "", err.Error() + "\n"
	}
	var findings []finding
	for _, path := range paths {
		hits, err := scanGoFile(root, path)
		if err != nil {
			return 1, "", err.Error() + "\n"
		}
		findings = append(findings, hits...)
	}
	if len(findings) == 0 {
		return 0, successMsg, ""
	}
	slices.SortFunc(findings, func(a, b finding) int {
		if c := strings.Compare(a.file, b.file); c != 0 {
			return c
		}
		return a.line - b.line
	})
	var out strings.Builder
	for _, f := range findings {
		fmt.Fprintf(&out, "%s:%d: interior comment block exceeds 2 lines\n", f.file, f.line)
	}
	n := len(findings)
	word := "blocks"
	if n == 1 {
		word = "block"
	}
	fmt.Fprintf(&out, "\ncomments: %d interior comment %s over 2 lines\n", n, word)
	return 1, out.String(), ""
}

func goFiles(root string) ([]string, error) {
	var paths []string
	mainPath := filepath.Join(root, "main.go")
	if info, err := os.Stat(mainPath); err == nil && !info.IsDir() {
		paths = append(paths, mainPath)
	}
	for _, dir := range []string{"internal", "embed", "e2e", "scripts"} {
		base := filepath.Join(root, dir)
		err := filepath.WalkDir(base, func(path string, d os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() {
				return nil
			}
			if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, ".gen.go") {
				return nil
			}
			paths = append(paths, path)
			return nil
		})
		if err != nil && !os.IsNotExist(err) {
			return nil, err
		}
	}
	slices.Sort(paths)
	return paths, nil
}

func rel(root, abs string) string {
	p, err := filepath.Rel(root, abs)
	if err != nil {
		return filepath.ToSlash(abs)
	}
	return filepath.ToSlash(p)
}

func docGroups(f *ast.File) map[*ast.CommentGroup]bool {
	out := map[*ast.CommentGroup]bool{}
	if f.Doc != nil {
		out[f.Doc] = true
	}
	for _, decl := range f.Decls {
		switch d := decl.(type) {
		case *ast.GenDecl:
			if d.Doc != nil {
				out[d.Doc] = true
			}
			for _, spec := range d.Specs {
				switch s := spec.(type) {
				case *ast.TypeSpec:
					if s.Doc != nil {
						out[s.Doc] = true
					}
				case *ast.ValueSpec:
					if s.Doc != nil {
						out[s.Doc] = true
					}
				}
			}
		case *ast.FuncDecl:
			if d.Doc != nil {
				out[d.Doc] = true
			}
		}
	}
	return out
}

func commentGroupLines(group *ast.CommentGroup) int {
	n := 0
	for _, c := range group.List {
		text := c.Text
		if strings.HasPrefix(text, "//") {
			n++
			continue
		}
		inner := strings.TrimPrefix(text, "/*")
		inner = strings.TrimSuffix(inner, "*/")
		n += strings.Count(inner, "\n") + 1
	}
	return n
}

func commentGroupStartsWithContext(group *ast.CommentGroup) bool {
	if len(group.List) == 0 {
		return false
	}
	text := group.List[0].Text
	var first string
	switch {
	case strings.HasPrefix(text, "//"):
		first = strings.TrimSpace(strings.TrimPrefix(text, "//"))
	case strings.HasPrefix(text, "/*"):
		inner := strings.TrimPrefix(text, "/*")
		inner = strings.TrimSuffix(inner, "*/")
		first = strings.TrimSpace(strings.Split(inner, "\n")[0])
	default:
		return false
	}
	return strings.HasPrefix(first, "context:")
}

func scanGoFile(root, path string) ([]finding, error) {
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, path, nil, parser.ParseComments)
	if err != nil {
		return nil, fmt.Errorf("parse %s: %w", rel(root, path), err)
	}
	docs := docGroups(f)
	var findings []finding
	for _, group := range f.Comments {
		if docs[group] || commentGroupStartsWithContext(group) {
			continue
		}
		if commentGroupLines(group) <= 2 {
			continue
		}
		pos := fset.Position(group.Pos())
		findings = append(findings, finding{file: rel(root, path), line: pos.Line})
	}
	return findings, nil
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
