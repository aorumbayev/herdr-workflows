package contract_test

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func installReleaseScript(t *testing.T) string {
	t.Helper()
	return filepath.Join(repoRoot(t), "scripts", "install-release.sh")
}

func TestInstallReleaseScriptExtractsVerifiedBinary(t *testing.T) {
	version := "0.9.0"
	osName, arch := mapRuntime(t)
	archive := "herdr-workflows_" + version + "_" + osName + "_" + arch + ".tar.gz"
	payload := gzipTarNamed(t, "herdr-workflows", []byte("script-bin"))
	sum := sha256.Sum256(payload)
	checksumBody := hex.EncodeToString(sum[:]) + "  " + archive + "\n"

	mux := http.NewServeMux()
	mux.HandleFunc("/checksums.txt", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(checksumBody))
	})
	mux.HandleFunc("/"+archive, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(payload)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	root := t.TempDir()
	toml := "id = \"herdr-workflows\"\nversion = \"" + version + "\"\n"
	if err := os.WriteFile(filepath.Join(root, "herdr-plugin.toml"), []byte(toml), 0o644); err != nil {
		t.Fatal(err)
	}
	scriptDir := filepath.Join(root, "scripts")
	if err := os.MkdirAll(scriptDir, 0o755); err != nil {
		t.Fatal(err)
	}
	src, err := os.ReadFile(installReleaseScript(t))
	if err != nil {
		t.Fatal(err)
	}
	dst := filepath.Join(scriptDir, "install-release.sh")
	if err := os.WriteFile(dst, src, 0o755); err != nil {
		t.Fatal(err)
	}

	cmd := exec.Command("sh", dst)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "HWF_RELEASE_BASE_URL="+srv.URL)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("install-release.sh: %v\n%s", err, out)
	}
	got, err := os.ReadFile(filepath.Join(root, "bin", "herdr-workflows"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "script-bin" {
		t.Fatalf("bin = %q", got)
	}
}

func TestInstallReleaseScriptChecksumMismatchLeavesBin(t *testing.T) {
	version := "0.9.0"
	osName, arch := mapRuntime(t)
	archive := "herdr-workflows_" + version + "_" + osName + "_" + arch + ".tar.gz"
	payload := gzipTarNamed(t, "herdr-workflows", []byte("script-bin"))
	checksumBody := "0000000000000000000000000000000000000000000000000000000000000000  " + archive + "\n"

	mux := http.NewServeMux()
	mux.HandleFunc("/checksums.txt", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(checksumBody))
	})
	mux.HandleFunc("/"+archive, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(payload)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	root := t.TempDir()
	toml := "id = \"herdr-workflows\"\nversion = \"" + version + "\"\n"
	if err := os.WriteFile(filepath.Join(root, "herdr-plugin.toml"), []byte(toml), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	prior := filepath.Join(root, "bin", "herdr-workflows")
	if err := os.WriteFile(prior, []byte("prior"), 0o755); err != nil {
		t.Fatal(err)
	}
	scriptDir := filepath.Join(root, "scripts")
	if err := os.MkdirAll(scriptDir, 0o755); err != nil {
		t.Fatal(err)
	}
	src, err := os.ReadFile(installReleaseScript(t))
	if err != nil {
		t.Fatal(err)
	}
	dst := filepath.Join(scriptDir, "install-release.sh")
	if err := os.WriteFile(dst, src, 0o755); err != nil {
		t.Fatal(err)
	}

	cmd := exec.Command("sh", dst)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "HWF_RELEASE_BASE_URL="+srv.URL)
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("expected failure, got %s", out)
	}
	got, readErr := os.ReadFile(prior)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(got) != "prior" {
		t.Fatalf("bin overwritten: %q", got)
	}
	if !strings.Contains(string(out), "checksum mismatch") {
		t.Fatalf("stderr = %q", out)
	}
}

func mapRuntime(t *testing.T) (string, string) {
	t.Helper()
	switch runtime.GOOS {
	case "linux", "darwin":
	default:
		t.Skipf("unsupported GOOS %s", runtime.GOOS)
	}
	switch runtime.GOARCH {
	case "amd64", "arm64":
	default:
		t.Skipf("unsupported GOARCH %s", runtime.GOARCH)
	}
	return runtime.GOOS, runtime.GOARCH
}

func gzipTarNamed(t *testing.T, name string, body []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	hdr := &tar.Header{Name: name, Mode: 0o755, Size: int64(len(body))}
	if err := tw.WriteHeader(hdr); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write(body); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}
