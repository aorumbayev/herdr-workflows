package workbench

import (
	"io"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

var tokenDeclRE = regexp.MustCompile(`(?i)--([a-z0-9-]+)\s*:\s*([^;]+);`)

func servedPage(t *testing.T) string {
	t.Helper()
	s := startTestServer(t, testRepo(t))
	res, err := http.Get(s.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", res.StatusCode)
	}
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

func extractBlock(t *testing.T, page string, startRE *regexp.Regexp) string {
	t.Helper()
	loc := startRE.FindStringIndex(page)
	if loc == nil {
		t.Fatalf("block start not found: %s", startRE)
	}
	from := page[loc[0]:]
	open := strings.Index(from, "{")
	if open < 0 {
		t.Fatal("opening brace not found")
	}
	depth := 0
	for i := open; i < len(from); i++ {
		switch from[i] {
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return from[open+1 : i]
			}
		}
	}
	t.Fatal("unclosed CSS block")
	return ""
}

func parseTokens(block string) map[string]string {
	out := map[string]string{}
	for _, m := range tokenDeclRE.FindAllStringSubmatch(block, -1) {
		out[m[1]] = strings.TrimSpace(m[2])
	}
	return out
}

func parseLiteral(value string) ([3]int, bool) {
	rgb := regexp.MustCompile(`(?i)^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:/\s*[\d.]+%?\s*)?\)$`).FindStringSubmatch(strings.TrimSpace(value))
	if rgb == nil {
		return [3]int{}, false
	}
	a, _ := strconv.Atoi(rgb[1])
	b, _ := strconv.Atoi(rgb[2])
	c, _ := strconv.Atoi(rgb[3])
	return [3]int{a, b, c}, true
}

func mixColor(a [3]int, pct float64, b [3]int) [3]int {
	t := pct / 100
	return [3]int{
		int(math.Round(float64(a[0])*t + float64(b[0])*(1-t))),
		int(math.Round(float64(a[1])*t + float64(b[1])*(1-t))),
		int(math.Round(float64(a[2])*t + float64(b[2])*(1-t))),
	}
}

func resolveColor(tokens map[string]string, name string, stack []string) [3]int {
	for _, seen := range stack {
		if seen == name {
			panic("cycle: " + name)
		}
	}
	raw, ok := tokens[name]
	if !ok {
		panic("missing token --" + name)
	}
	if lit, ok := parseLiteral(raw); ok {
		return lit
	}
	switch strings.ToLower(raw) {
	case "white":
		return [3]int{255, 255, 255}
	case "black":
		return [3]int{0, 0, 0}
	}
	if m := regexp.MustCompile(`(?i)^var\(--([a-z0-9-]+)\)$`).FindStringSubmatch(raw); m != nil {
		return resolveColor(tokens, m[1], append(stack, name))
	}
	if m := regexp.MustCompile(`(?i)^color-mix\(\s*in\s+srgb\s*,\s*var\(--([a-z0-9-]+)\)\s+(\d+(?:\.\d+)?)%\s*,\s*var\(--([a-z0-9-]+)\)\s*\)$`).FindStringSubmatch(raw); m != nil {
		a := resolveColor(tokens, m[1], append(stack, name))
		b := resolveColor(tokens, m[3], append(stack, name))
		pct, _ := strconv.ParseFloat(m[2], 64)
		return mixColor(a, pct, b)
	}
	if m := regexp.MustCompile(`(?i)^color-mix\(\s*in\s+srgb\s*,\s*var\(--([a-z0-9-]+)\)\s+(\d+(?:\.\d+)?)%\s*,\s*(black|white)\s*\)$`).FindStringSubmatch(raw); m != nil {
		a := resolveColor(tokens, m[1], append(stack, name))
		pct, _ := strconv.ParseFloat(m[2], 64)
		b := [3]int{255, 255, 255}
		if strings.EqualFold(m[3], "black") {
			b = [3]int{0, 0, 0}
		}
		return mixColor(a, pct, b)
	}
	panic("unresolvable --" + name + ": " + raw)
}

func lin(c int) float64 {
	s := float64(c) / 255
	if s <= 0.04045 {
		return s / 12.92
	}
	return math.Pow((s+0.055)/1.055, 2.4)
}

func lum(rgb [3]int) float64 {
	return 0.2126*lin(rgb[0]) + 0.7152*lin(rgb[1]) + 0.0722*lin(rgb[2])
}

func contrast(a, b [3]int) float64 {
	l1, l2 := lum(a), lum(b)
	hi, lo := l1, l2
	if l2 > l1 {
		hi, lo = l2, l1
	}
	return (hi + 0.05) / (lo + 0.05)
}

func TestPresentationThemeTokensAndHighlightedYAML(t *testing.T) {
	// Ports test/workbench/web-presentation.test.ts "page exposes theme tokens, control, and highlighted YAML display".
	page := servedPage(t)
	for _, want := range []string{"--nord0:", "--nord15:", `id="theme-btn"`, `aria-label="Theme: system"`, "hwf-theme"} {
		if !strings.Contains(page, want) {
			t.Fatalf("page missing %q", want)
		}
	}
	if !regexp.MustCompile(`:root\[data-theme=["']light["']\]`).MatchString(page) {
		t.Fatal("page missing light theme token block selector")
	}
	if !regexp.MustCompile(`className\s*=\s*["']yaml["']`).MatchString(page) {
		t.Fatal("missing highlighted yaml className")
	}
	if !regexp.MustCompile(`innerHTML\s*=\s*highlight\(`).MatchString(page) {
		t.Fatal("missing highlight() innerHTML wiring")
	}
	if regexp.MustCompile(`\.textContent\s*=\s*[^;]*\.yaml\b`).MatchString(page) {
		t.Fatal("yaml uses textContent instead of innerHTML")
	}
	if regexp.MustCompile(`createElement\(\s*["']pre["']\s*\)[\s\S]{0,120}textContent\s*=`).MatchString(page) {
		t.Fatal("pre yaml uses textContent")
	}
}

func TestPresentationColourLiteralsOnlyInTokenBlocks(t *testing.T) {
	// Ports test/workbench/web-presentation.test.ts "colour literals appear only inside the two token blocks".
	page := servedPage(t)
	styleStart := strings.Index(page, "<style>")
	styleEnd := strings.Index(page, "</style>")
	if styleStart < 0 || styleEnd < 0 {
		t.Fatal("style block not found")
	}
	style := page[styleStart:styleEnd]
	rest := style
	for _, re := range []*regexp.Regexp{
		regexp.MustCompile(`:root\s*\{`),
		regexp.MustCompile(`:root\[data-theme=["']light["']\]\s*\{`),
	} {
		block := extractBlock(t, rest, re)
		rest = strings.Replace(rest, block, "", 1)
	}
	leaked := regexp.MustCompile(`(?i)#[0-9a-f]{3,8}\b|\brgba?\(`).FindAllString(rest, -1)
	if len(leaked) > 0 {
		t.Fatalf("colour literal outside token blocks: %v", leaked)
	}
}

func TestPresentationLightBlockDeclaresDarkSemanticTokens(t *testing.T) {
	// Ports test/workbench/web-presentation.test.ts "light block declares every dark semantic colour token".
	page := servedPage(t)
	dark := parseTokens(extractBlock(t, page, regexp.MustCompile(`:root\s*\{`)))
	light := parseTokens(extractBlock(t, page, regexp.MustCompile(`:root\[data-theme=["']light["']\]\s*\{`)))
	skip := map[string]bool{
		"nord0": true, "nord1": true, "nord2": true, "nord3": true, "nord4": true,
		"nord5": true, "nord6": true, "nord7": true, "nord8": true, "nord9": true,
		"nord10": true, "nord11": true, "nord12": true, "nord13": true, "nord14": true,
		"nord15": true, "radius": true, "radius-sm": true, "mono": true,
	}
	for name := range dark {
		if skip[name] || strings.HasPrefix(name, "nord") {
			continue
		}
		_, ok := light[name]
		if !ok {
			t.Fatalf("light missing --%s", name)
		}
	}
}

func TestPresentationWCAGContrast(t *testing.T) {
	// Ports test/workbench/web-presentation.test.ts "ink, muted, and tok-* meet WCAG AA contrast in both themes".
	page := servedPage(t)
	dark := parseTokens(extractBlock(t, page, regexp.MustCompile(`:root\s*\{`)))
	light := map[string]string{}
	for k, v := range dark {
		light[k] = v
	}
	for k, v := range parseTokens(extractBlock(t, page, regexp.MustCompile(`:root\[data-theme=["']light["']\]\s*\{`))) {
		light[k] = v
	}
	check := func(tokens map[string]string, label string) {
		t.Helper()
		surface := resolveColor(tokens, "bg", nil)
		for _, name := range []string{"ink", "muted"} {
			if contrast(resolveColor(tokens, name, nil), surface) < 4.5 {
				t.Fatalf("%s --%s vs --bg below 4.5:1", label, name)
			}
		}
		for name := range tokens {
			if !strings.HasPrefix(name, "tok-") {
				continue
			}
			if contrast(resolveColor(tokens, name, nil), surface) < 4.5 {
				t.Fatalf("%s --%s vs --bg below 4.5:1", label, name)
			}
		}
	}
	check(dark, "dark")
	check(light, "light")
}

func TestPresentationCanvasHierarchyTokens(t *testing.T) {
	// Ports test/workbench/web-presentation.test.ts "canvas hierarchy tokens distinguish node surface, border, port, and edge".
	page := servedPage(t)
	dark := parseTokens(extractBlock(t, page, regexp.MustCompile(`:root\s*\{`)))
	light := map[string]string{}
	for k, v := range dark {
		light[k] = v
	}
	for k, v := range parseTokens(extractBlock(t, page, regexp.MustCompile(`:root\[data-theme=["']light["']\]\s*\{`))) {
		light[k] = v
	}
	for _, name := range []string{"node-surface", "node-border", "node-shadow", "port", "edge", "canvas-bg"} {
		if dark[name] == "" {
			t.Fatalf("dark missing --%s", name)
		}
		if light[name] == "" {
			t.Fatalf("light missing --%s", name)
		}
	}
	styleStart := strings.Index(page, "<style>")
	styleEnd := strings.Index(page, "</style>")
	style := page[styleStart:styleEnd]
	for _, re := range []string{
		`\.node\s*\{[^}]*background:\s*var\(--node-surface\)`,
		`\.node\s*\{[^}]*border:[^;]*var\(--node-border\)`,
		`\.node\s*\{[^}]*box-shadow:\s*var\(--node-shadow\)`,
		`\.node\s*\.port\s*\{[^}]*background:\s*var\(--port\)`,
		`\.canvas\s*\.edges\s*path\s*\{[^}]*stroke:\s*var\(--edge\)`,
	} {
		if !regexp.MustCompile(re).MatchString(style) {
			t.Fatalf("style missing %q", re)
		}
	}
	for _, tc := range []struct {
		tokens map[string]string
		label  string
	}{
		{dark, "dark"},
		{light, "light"},
	} {
		canvas := resolveColor(tc.tokens, "canvas-bg", nil)
		surface := resolveColor(tc.tokens, "node-surface", nil)
		border := resolveColor(tc.tokens, "node-border", nil)
		edge := resolveColor(tc.tokens, "edge", nil)
		port := resolveColor(tc.tokens, "port", nil)
		if surface == canvas {
			t.Fatalf("%s node-surface must differ from canvas-bg", tc.label)
		}
		if border == canvas {
			t.Fatalf("%s node-border must differ from canvas-bg", tc.label)
		}
		if contrast(edge, canvas) < 1.4 {
			t.Fatalf("%s --edge vs --canvas-bg below 1.4:1", tc.label)
		}
		if contrast(port, canvas) < 1.4 {
			t.Fatalf("%s --port vs --canvas-bg below 1.4:1", tc.label)
		}
	}
}

func TestPresentationEditorAccessibilityAndLayout(t *testing.T) {
	// Ports test/workbench/web-presentation.test.ts "editor exposes accessible dirty state, history, and expanded canvas controls".
	page := servedPage(t)
	for _, want := range []string{
		"unsaved changes",
		"discard unsaved workflow changes?",
		`"not saved — "`,
		`"not deleted — "`,
		`setAttribute("aria-label", "Undo")`,
		`setAttribute("aria-label", "Redo")`,
		`setAttribute("aria-label", "Save")`,
		`setAttribute("aria-label", "Add step")`,
		`setAttribute("aria-label", "Keyboard shortcuts")`,
		`name: "Fit canvas"`,
		`name: "Expand canvas"`,
		"Exit expanded canvas",
		`name: "Reset zoom"`,
		`"More actions"`,
		`setAttribute("aria-haspopup", "menu")`,
		`setAttribute("role", "menu")`,
		`setAttribute("role", "menuitem")`,
		`id="list-rail"`,
		`aria-label="Show workflow list"`,
		`aria-label", "Hide workflow list"`,
		`aria-controls="list"`,
		"canvas-expanded",
		".canvas.expanded",
		".viewbar",
		".zoombar",
		".list-actions",
		".list-chrome",
		".bar-spacer",
		"list-collapsed",
		"flex: 1 0 100%",
		"grid-template-columns: minmax(0, 1fr)",
		".status:empty",
	} {
		if !strings.Contains(page, want) {
			t.Fatalf("page missing %q", want)
		}
	}
	for _, forbidden := range []string{"move to ", "run in a terminal:", `id="list-btn"`} {
		if strings.Contains(page, forbidden) {
			t.Fatalf("page contains forbidden %q", forbidden)
		}
	}
	for _, re := range []string{
		`\.zoombar\s*button\s*,\s*\.viewbar\s*button\s*\{[^}]*min-height:\s*32px`,
		`\.bar\s*button\s*\{[^}]*min-height:\s*32px`,
		`@media\s*\(max-width:\s*720px\)`,
		`@media\s*\(max-width:\s*480px\)`,
		`\.hide\s*\{\s*display:\s*none\s*!important`,
		`\.canvas\s*\{[^}]*flex:\s*1 1 auto`,
	} {
		if !regexp.MustCompile(re).MatchString(page) {
			t.Fatalf("page missing pattern %q", re)
		}
	}
	if regexp.MustCompile(`method:\s*"DELETE",\s*\n\s*body: JSON.stringify\(\{ name: prev`).MatchString(page) {
		t.Fatal("page uses client-side delete-then-write move sequence")
	}
}
