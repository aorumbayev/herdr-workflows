// Command verify-prose applies the machine-checked docs style rules.
// Run from the repository root:
//
//	go run ./scripts/verify-prose [root]
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"
)

const expectations = `
This check is the machine-checked subset of the docs style (AGENTS.md, "Docs style"):

  UI verbs     select, not click / tap / double-click. press, not hit. enter, not key in.
               sign in and sign out, not log in and log out.
  Wordiness    to, because, if, about, before, after, use, help, start — not their
               long forms (in order to, due to the fact that, prior to, utilize...).
  Filler       simply, just, easily, quickly, please, basically, actually, obviously.
  Direction    no "see above" or "see below". more than / less than, not over / under.
  Naming       GitHub, PowerShell, JavaScript, TypeScript, macOS. US spelling.
  Machines     herdr reports, requires, reads — never thinks, wants, sees, knows.

Fix the lines listed, or, when a match is a genuine technical term, wrap it in
backticks. Code spans, fenced blocks, and link targets are not scanned.

Voice, sentence length, and terminology consistency are not checked here. They
follow CONTRIBUTING.md, "Documentation style" (Simplified Technical English).
`

var (
	rootFiles = []string{"README.md", "CONTRIBUTING.md", "AGENTS.md"}
	rootDirs  = []string{"docs", "skills", ".agents/skills"}
	skipDirs  = map[string]bool{".vitepress": true, "node_modules": true}
)

type rule struct {
	re  *regexp.Regexp
	use string
	why string
}

var rules = []rule{
	{regexp.MustCompile(`(?i)\bclicks?(\s+on)?\b`), "select", "one verb covers mouse, keyboard, and touch"},
	{regexp.MustCompile(`(?i)\bdouble-click\b`), "select", "unless the double action is literally required"},
	{regexp.MustCompile(`(?i)\btaps?\b`), "select", "`tap` belongs only in touch-specific content"},
	{regexp.MustCompile(`(?i)\bhit\s+(the\s+)?(enter|escape|key|button)\b`), "press, or select", "`hit` is not a UI verb"},
	{regexp.MustCompile(`(?i)\bkey\s+in\b`), "enter", "`key in` is dated"},
	{regexp.MustCompile(`(?i)\blog\s?(in|into|on|out|off)\b`), "sign in, sign out", "Microsoft uses sign in / sign out"},
	{regexp.MustCompile(`(?i)\blog(in|out)\s+(screen|page|button|form)\b`), "sign-in screen", "hyphenate the modifier"},
	{regexp.MustCompile(`(?i)\bin order to\b`), "to", "the extra words carry nothing"},
	{regexp.MustCompile(`(?i)\bdue to the fact that\b`), "because", ""},
	{regexp.MustCompile(`(?i)\bat this point in time\b`), "now", ""},
	{regexp.MustCompile(`(?i)\bin the event that\b`), "if", ""},
	{regexp.MustCompile(`(?i)\bwith regard to\b`), "about", ""},
	{regexp.MustCompile(`(?i)\butilize[sd]?\b`), "use", ""},
	{regexp.MustCompile(`(?i)\bleverages?\b`), "use", "`leverage` is a noun outside finance"},
	{regexp.MustCompile(`(?i)\bfacilitates?\b`), "help, make it easier", ""},
	{regexp.MustCompile(`(?i)\bcommences?\b`), "start", ""},
	{regexp.MustCompile(`(?i)\bprior to\b`), "before", ""},
	{regexp.MustCompile(`(?i)\bsubsequent to\b`), "after", ""},
	{regexp.MustCompile(`(?i)\bsimply\b`), "nothing — delete it", "it tells the reader their trouble is their own fault"},
	{regexp.MustCompile(`(?i)\bjust\s+(click|select|run|add|use|open|type)\b`), "the verb alone", "`just` minimizes the reader's work"},
	{regexp.MustCompile(`(?i)\b(easily|quickly|smoothly|effortlessly)\b`), "nothing — delete it", "claims the reader's experience for them"},
	{regexp.MustCompile(`(?i)\bplease\b`), "nothing — delete it", "instructions are not requests"},
	{regexp.MustCompile(`(?i)\b(basically|actually|obviously|of course)\b`), "nothing — delete it", "filler, or condescending"},
	{regexp.MustCompile(`(?i)\bwhilst\b`), "while, or although", ""},
	{regexp.MustCompile(`(?i)\bsee (the )?(table|section|list|note)? ?(above|below)\b`), "preceding / following, or a link", "position changes with rendering"},
	{regexp.MustCompile(`(?i)\b(over|under)\s+\d`), "more than, less than", "`over` and `under` are spatial"},
	{regexp.MustCompile(`(?i)\b(herdr|hwf|the (app|system|plugin|picker|workbench|runner|loader))\s+(thinks|wants|sees|understands|knows|feels|believes)\b`), "reports, requires, reads, accepts", "software has no inner life"},
	{regexp.MustCompile(`(?i)\b(white|black)\s?list(ed|ing)?\b`), "allowlist, blocklist", ""},
	{regexp.MustCompile(`(?i)\b(master|slave)\b`), "primary, replica", ""},
	{regexp.MustCompile(`(?i)\bsanity check\b`), "quick check, verify", ""},
	{regexp.MustCompile(`(?i)\bdummy data\b`), "sample data", ""},
	{regexp.MustCompile(`\bGithub\b`), "GitHub", "capital H"},
	{regexp.MustCompile(`\b(Powershell|power shell)\b`), "PowerShell", ""},
	{regexp.MustCompile(`\bJavascript\b`), "JavaScript", ""},
	{regexp.MustCompile(`\bTypescript\b`), "TypeScript", ""},
	{regexp.MustCompile(`\b(Mac OS|OS X)\b`), "macOS", ""},
	{regexp.MustCompile(`(?i)\b(recogni|organi|customi|initiali|seriali|normali|summari|prioriti|optimi|synchroni|authori|standardi|categori|minimi|maximi)s(e|ed|es|ing|ation)\b`), "-ize spelling", "US spelling"},
	{regexp.MustCompile(`(?i)\b(analys(e|ed|es|ing)|behaviour|colour|centre|licence|defence|artefact|catalogue|dialogue|programme|grey|labell(ed|ing)|cancell(ed|ing)|modelling|travelled)\b`), "US spelling", ""},
	{regexp.MustCompile(`(?i)\bemail address\b`), "email", "`address` is redundant"},
	{regexp.MustCompile(`; +[^\s;]`), "two sentences", "no semicolons in prose"},
}

type finding struct {
	file   string
	line   int
	column int
	text   string
	rule   rule
}

var (
	fenceLine = regexp.MustCompile(`^\s*(` + "```" + `|~~~)`)
	inline    = regexp.MustCompile("`[^`]*`")
	link      = regexp.MustCompile(`\]\([^)]*\)`)
	urlAngle  = regexp.MustCompile(`<https?:[^>]*>`)
	urlBare   = regexp.MustCompile(`https?://\S+`)
)

func maskCode(text string) string {
	lines := strings.Split(text, "\n")
	inFence := false
	for i, line := range lines {
		if fenceLine.MatchString(line) {
			inFence = !inFence
			lines[i] = strings.Repeat(" ", len(line))
			continue
		}
		if inFence {
			lines[i] = strings.Repeat(" ", len(line))
			continue
		}
		line = inline.ReplaceAllStringFunc(line, func(m string) string {
			return strings.Repeat(" ", len(m))
		})
		line = link.ReplaceAllStringFunc(line, func(m string) string {
			return strings.Repeat(" ", len(m))
		})
		line = urlAngle.ReplaceAllStringFunc(line, func(m string) string {
			return strings.Repeat(" ", len(m))
		})
		line = urlBare.ReplaceAllStringFunc(line, func(m string) string {
			return strings.Repeat(" ", len(m))
		})
		lines[i] = line
	}
	return strings.Join(lines, "\n")
}

func markdownFiles(root string) ([]string, error) {
	var found []string
	for _, name := range rootFiles {
		path := filepath.Join(root, name)
		if _, err := os.Stat(path); err == nil {
			found = append(found, path)
		}
	}
	for _, dir := range rootDirs {
		base := filepath.Join(root, dir)
		if _, err := os.Stat(base); err != nil {
			continue
		}
		err := filepath.WalkDir(base, func(path string, d os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() && skipDirs[d.Name()] {
				return filepath.SkipDir
			}
			if !d.IsDir() && strings.HasSuffix(d.Name(), ".md") {
				found = append(found, path)
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	slices.Sort(found)
	return found, nil
}

func scanFile(root, path string) ([]finding, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	rel, err := filepath.Rel(root, path)
	if err != nil {
		rel = path
	}
	rel = filepath.ToSlash(rel)
	lines := strings.Split(maskCode(string(data)), "\n")
	var findings []finding
	for i, line := range lines {
		for _, r := range rules {
			locs := r.re.FindAllStringIndex(line, -1)
			for _, loc := range locs {
				findings = append(findings, finding{
					file:   rel,
					line:   i + 1,
					column: loc[0] + 1,
					text:   line[loc[0]:loc[1]],
					rule:   r,
				})
			}
		}
	}
	return findings, nil
}

// Check examines markdown prose in root.
func Check(root string) (exitCode int, stdout, stderr string) {
	files, err := markdownFiles(root)
	if err != nil {
		return 1, "", err.Error() + "\n"
	}
	var findings []finding
	for _, path := range files {
		hits, err := scanFile(root, path)
		if err != nil {
			return 1, "", err.Error() + "\n"
		}
		findings = append(findings, hits...)
	}
	slices.SortFunc(findings, func(a, b finding) int {
		if c := strings.Compare(a.file, b.file); c != 0 {
			return c
		}
		if a.line != b.line {
			return a.line - b.line
		}
		return a.column - b.column
	})
	if len(findings) == 0 {
		return 0, fmt.Sprintf("prose: %d files clean\n", len(files)), ""
	}
	var out strings.Builder
	current := ""
	for _, f := range findings {
		if f.file != current {
			current = f.file
			fmt.Fprintf(&out, "\n%s\n", current)
		}
		why := ""
		if f.rule.why != "" {
			why = " (" + f.rule.why + ")"
		}
		fmt.Fprintf(&out, "  %d:%d  %q → %s%s\n", f.line, f.column, f.text, f.rule.use, why)
	}
	out.WriteString(expectations)
	hits := len(findings)
	bad := map[string]struct{}{}
	for _, f := range findings {
		bad[f.file] = struct{}{}
	}
	issueWord := "issues"
	if hits == 1 {
		issueWord = "issue"
	}
	fileWord := "files"
	if len(bad) == 1 {
		fileWord = "file"
	}
	fmt.Fprintf(&out, "prose: %d %s in %d %s\n", hits, issueWord, len(bad), fileWord)
	return 1, out.String(), ""
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
