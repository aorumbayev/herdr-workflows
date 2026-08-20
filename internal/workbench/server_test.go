package workbench

import (
	"io"
	"net/http"
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
