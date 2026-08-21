package workbench

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMissingTokenRejected(t *testing.T) {
	// Ports test/workbench/web-server.test.ts "missing token rejected, no read".
	s := startTestServer(t, testRepo(t))
	res, err := http.Get(originOf(s.port) + "/api/state")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", res.StatusCode)
	}
}

func TestForeignOriginRejected(t *testing.T) {
	// Ports test/workbench/web-server.test.ts "foreign origin rejected".
	s := startTestServer(t, testRepo(t))
	req, err := http.NewRequest(http.MethodGet, originOf(s.port)+"/api/state", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Hwf-Token", s.Token)
	req.Header.Set("Origin", "http://evil.example.com")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", res.StatusCode)
	}
}

func TestValidTokenServesStatePlaceholder(t *testing.T) {
	// Auth seam only: token+host reach /api/state. Payload parity is api.go.
	s := startTestServer(t, testRepo(t))
	req, err := http.NewRequest(http.MethodGet, originOf(s.port)+"/api/state", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Hwf-Token", s.Token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	_, _ = io.Copy(io.Discard, res.Body)
	if res.StatusCode == http.StatusForbidden {
		t.Fatal("valid token was forbidden")
	}
}

func TestAuthenticatedAPIJSONUsesNoStore(t *testing.T) {
	s := startTestServer(t, testRepo(t))
	cases := []struct {
		method string
		path   string
		body   string
	}{
		{http.MethodGet, "/api/state", ""},
		{http.MethodGet, "/api/schema", ""},
		{http.MethodGet, "/api/methods", ""},
		{http.MethodGet, "/api/runs", ""},
		{http.MethodGet, "/api/run?id=not-a-uuid", ""},
		{http.MethodGet, "/api/workflow?name=missing&scope=repo", ""},
		{http.MethodGet, "/api/config?scope=repo", ""},
		{http.MethodGet, "/api/share?name=missing&scope=repo", ""},
		{http.MethodPost, "/api/parse", `{"text":"version: v1alpha1\n"}`},
		{http.MethodPost, "/api/format", `{"doc":{"version":"v1alpha1","name":"t","steps":[]}}`},
		{http.MethodPost, "/api/validate", `{"name":"t","text":"version: v1alpha1\nname: t\nsteps: []\n"}`},
		{http.MethodPost, "/api/import/preview", `{"text":""}`},
		{http.MethodPost, "/api/import", `{"text":"","scope":"repo"}`},
	}
	for _, tc := range cases {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			var body io.Reader
			if tc.body != "" {
				body = strings.NewReader(tc.body)
			}
			req, err := http.NewRequest(tc.method, originOf(s.port)+tc.path, body)
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("X-Hwf-Token", s.Token)
			if tc.body != "" {
				req.Header.Set("Content-Type", "application/json")
			}
			res, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = res.Body.Close() }()
			_, _ = io.Copy(io.Discard, res.Body)
			if !strings.Contains(res.Header.Get("Content-Type"), "application/json") {
				t.Fatalf("content-type = %q, want application/json", res.Header.Get("Content-Type"))
			}
			if got := res.Header.Get("Cache-Control"); got != "no-store" {
				t.Fatalf("Cache-Control = %q, want no-store", got)
			}
		})
	}

	favicon, err := http.Get(originOf(s.port) + "/favicon.svg")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = favicon.Body.Close() }()
	if cc := favicon.Header.Get("Cache-Control"); !strings.Contains(cc, "public") {
		t.Fatalf("favicon Cache-Control = %q, want public", cc)
	}
}

func TestWriteJSONIsSoleAuthenticatedJSONHelper(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	var encoderFiles []string
	for _, name := range files {
		if strings.HasSuffix(name, "_test.go") {
			continue
		}
		src, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(src, []byte("json.NewEncoder")) {
			encoderFiles = append(encoderFiles, name)
		}
	}
	if len(encoderFiles) != 1 || encoderFiles[0] != "server.go" {
		t.Fatalf("json.NewEncoder files = %v, want only server.go via writeJSON", encoderFiles)
	}
	src, err := os.ReadFile("server.go")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(src, []byte(`w.Header().Set("Cache-Control", "no-store")`)) {
		t.Fatal("writeJSON must set Cache-Control: no-store")
	}

	rec := httptest.NewRecorder()
	writeJSON(rec, http.StatusOK, map[string]any{"ok": true})
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("writeJSON Cache-Control = %q, want no-store", got)
	}
	if !strings.Contains(rec.Header().Get("Content-Type"), "application/json") {
		t.Fatalf("writeJSON Content-Type = %q", rec.Header().Get("Content-Type"))
	}
}

func TestServeHTTPRegistersOnlyKnownAPIPaths(t *testing.T) {
	src, err := os.ReadFile("server.go")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		`case "/api/state":`,
		`case "/api/schema":`,
		`case "/api/methods":`,
		`case "/api/workflow":`,
		`case "/api/parse":`,
		`case "/api/format":`,
		`case "/api/validate":`,
		`case "/api/config":`,
		`case "/api/runs":`,
		`case "/api/run":`,
		`case "/api/share":`,
		`case "/api/import/preview":`,
		`case "/api/import":`,
	}
	for _, line := range want {
		if !bytes.Contains(src, []byte(line)) {
			t.Fatalf("ServeHTTP missing %s", line)
		}
	}
	cases := 0
	for _, line := range strings.Split(string(src), "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, `case "/api/`) {
			cases++
		}
	}
	if cases != len(want) {
		t.Fatalf("ServeHTTP /api case count = %d, want %d (add path to no-store table)", cases, len(want))
	}
}
