package workbench

import (
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func TestMain(m *testing.M) {
	if tr, ok := http.DefaultTransport.(*http.Transport); ok {
		tr.DisableKeepAlives = true
	}
	os.Exit(m.Run())
}

func testRepo(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	plugin := t.TempDir()
	t.Setenv("HERDR_PLUGIN_CONFIG_DIR", plugin)
	if err := os.MkdirAll(filepath.Join(root, ".hwf", "workflows"), 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := "profiles:\n  claude:\n    kind: claude\ndefault_profile: claude\n"
	if err := os.WriteFile(filepath.Join(root, ".hwf", "config.yaml"), []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
	return root
}

func startTestServer(t *testing.T, root string) *Server {
	t.Helper()
	token, err := newToken()
	if err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := serveListener(root, token, ln)
	t.Cleanup(s.Stop)
	return s
}
