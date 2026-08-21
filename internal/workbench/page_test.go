package workbench

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	assets "github.com/aorumbayev/herdr-workflows/embed"
)

func fetchPage(t *testing.T, s *Server) string {
	t.Helper()
	res, err := http.Get(s.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

func TestFaviconIsPublicSVG(t *testing.T) {
	// Ports test/workbench/web-server.test.ts "favicon is public svg".
	s := startTestServer(t, testRepo(t))
	res, err := http.Get(originOf(s.port) + "/favicon.svg")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	if ct := res.Header.Get("Content-Type"); !strings.Contains(ct, "image/svg+xml") {
		t.Fatalf("content-type = %q, want image/svg+xml", ct)
	}
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "<svg") {
		t.Fatal("favicon body missing <svg")
	}
}

func TestPageDoesNotImportEsbuild(t *testing.T) {
	src, err := os.ReadFile("page.go")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(src), "github.com/evanw/esbuild") {
		t.Fatal("page.go must not import esbuild; field-model.js is inlined with string replace")
	}
}

func TestPageDoesNotStripExportPrefix(t *testing.T) {
	src, err := os.ReadFile("page.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(src)
	if strings.Contains(text, "exportPrefix") || strings.Contains(text, `^export `) {
		t.Fatal("page.go must not strip exportPrefix; embed/field-model.js has no export statements")
	}
	if strings.Contains(text, `"regexp"`) {
		t.Fatal("page.go must not import regexp after exportPrefix deletion")
	}
}

func TestEmbeddedAssetsMatchSource(t *testing.T) {
	wantPage, err := os.ReadFile(filepath.Join("..", "..", "embed", "page.html"))
	if err != nil {
		t.Fatal(err)
	}
	if assets.PageHTML != string(wantPage) {
		t.Fatal("assets.PageHTML drifted from embed/page.html")
	}
	wantModel, err := os.ReadFile(filepath.Join("..", "..", "embed", "field-model.js"))
	if err != nil {
		t.Fatal(err)
	}
	if assets.FieldModelJS != string(wantModel) {
		t.Fatal("assets.FieldModelJS drifted from embed/field-model.js")
	}
}

func TestServedPageInlinesExecutableFieldModelJavaScript(t *testing.T) {
	// Ports test/workbench/web-presentation.test.ts "served page inlines executable field-model JavaScript".
	s := startTestServer(t, testRepo(t))
	page := fetchPage(t, s)
	start := strings.Index(page, "function widgetFor(")
	end := strings.Index(page, "// The two generated sources the field model reads")
	if start < 0 || end <= start {
		t.Fatal("field model block not found in served page")
	}
	js := page[start:end]
	if strings.Contains(js, "function ") && strings.Contains(js, ":") {
		// TypeScript type annotations on functions would survive a failed transform.
		for _, line := range strings.Split(js, "\n") {
			if strings.HasPrefix(strings.TrimSpace(line), "function ") && strings.Contains(line, "):") {
				t.Fatalf("typescript syntax leaked into served field model: %q", line)
			}
		}
	}
	if strings.Contains(js, "export ") {
		t.Fatal("served field model still contains export statements")
	}
	if !strings.Contains(page, "function addressesField") {
		t.Fatal("served page missing function addressesField")
	}
}

func TestServedPageWiresShareAndImportViews(t *testing.T) {
	// Ports test/workbench/web-server.test.ts "served page wires #share and #import views without a run action".
	s := startTestServer(t, testRepo(t))
	page := fetchPage(t, s)

	if !strings.Contains(page, `hash === "import"`) {
		t.Fatal("missing import hash route")
	}
	if !strings.Contains(page, `hash === "new"`) {
		t.Fatal("missing new hash route")
	}
	if !strings.Contains(page, `^share=(repo|global):`) {
		t.Fatal("missing share hash pattern")
	}
	if !strings.Contains(page, "if (!hash) {") {
		t.Fatal("missing empty-hash branch")
	}
	if !strings.Contains(page, "/api/share?") {
		t.Fatal("missing share API wiring")
	}
	if !strings.Contains(page, "/api/import/preview") {
		t.Fatal("missing import preview API wiring")
	}
	if !strings.Contains(page, `label: "share"`) {
		t.Fatal("missing share label copy")
	}
	if !strings.Contains(page, "copy import command") {
		t.Fatal("missing import command copy")
	}
	if !strings.Contains(page, "confirm import") {
		t.Fatal("missing confirm import copy")
	}
	if !strings.Contains(page, "replace existing workflows") {
		t.Fatal("missing replace existing workflows copy")
	}
	if !strings.Contains(page, "no run") {
		t.Fatal("missing no run copy")
	}
	for _, forbidden := range []string{"run imported", "import and run", "run this bundle"} {
		if strings.Contains(strings.ToLower(page), strings.ToLower(forbidden)) {
			t.Fatalf("page contains forbidden import/run copy %q", forbidden)
		}
	}
	if !strings.Contains(page, `aria-label", "import command"`) {
		t.Fatal("missing import command aria label")
	}
	if !strings.Contains(page, `aria-label", "Import workflows"`) {
		t.Fatal("missing Import workflows aria label")
	}
	if !strings.Contains(page, "aria-readonly") {
		t.Fatal("missing aria-readonly on import surfaces")
	}
	if !strings.Contains(page, "tabIndex") || !strings.Contains(page, "= 0") {
		t.Fatal("missing tabIndex on import surfaces")
	}
}

func TestServedPageGuardsDirtyNavigation(t *testing.T) {
	// Ports test/workbench/web-server.test.ts "served page guards dirty navigation with confirm copy and hash restore".
	s := startTestServer(t, testRepo(t))
	page := fetchPage(t, s)

	for _, want := range []string{
		"discard unsaved config changes?",
		"discard unsaved workflow changes?",
		"unsaved changes",
		"#run=",
		"beforeunload",
	} {
		if !strings.Contains(page, want) {
			t.Fatalf("page missing %q", want)
		}
	}
	if strings.Contains(page, "moved to ") {
		t.Fatal("page contains stale moved-to copy")
	}
	if !strings.Contains(page, `history.replaceState(null, "", location.pathname + location.search + want)`) {
		t.Fatal("missing hash restore on dirty leave cancel")
	}
	restoreCount := strings.Count(page, `history.replaceState(null, "", location.pathname`)
	if restoreCount < 1 {
		t.Fatal("missing hash restore sites")
	}
	hashFnStart := strings.Index(page, "function applyHash() {")
	if hashFnStart < 0 {
		t.Fatal("applyHash not found")
	}
	hashFnEnd := strings.Index(page[hashFnStart:], "\n      let liveSig")
	if hashFnEnd < 0 {
		t.Fatal("applyHash body end not found")
	}
	hashBody := page[hashFnStart : hashFnStart+hashFnEnd]
	if strings.Count(hashBody, "confirmLeave()") < 4 {
		t.Fatalf("applyHash confirmLeave calls = %d, want >= 4", strings.Count(hashBody, "confirmLeave()"))
	}
	if !strings.Contains(page, `querySelectorAll(".tab")`) || !strings.Contains(page, "confirmLeave()") {
		t.Fatal("tab transitions must call confirmLeave")
	}
}

func TestServedPageHeaders(t *testing.T) {
	s := startTestServer(t, testRepo(t))
	res, err := http.Get(s.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("cache-control = %q, want no-store", res.Header.Get("Cache-Control"))
	}
	if ct := res.Header.Get("Content-Type"); ct != "text/html; charset=utf-8" {
		t.Fatalf("content-type = %q", ct)
	}
}
