package update

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const recoverySeed = "prior-dest-seed-bytes"

func seedDest(t *testing.T) string {
	t.Helper()
	dest := filepath.Join(t.TempDir(), "herdr-workflows")
	if err := os.WriteFile(dest, []byte(recoverySeed), 0o755); err != nil {
		t.Fatal(err)
	}
	return dest
}

func assertDestUnchanged(t *testing.T, dest string) {
	t.Helper()
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != recoverySeed {
		t.Fatalf("dest changed: got %q, want %q", got, recoverySeed)
	}
}

func recoveryServer(t *testing.T, version, goos, goarch string, checksumBody string, archiveStatus int, archiveBody []byte) *httptest.Server {
	t.Helper()
	archive := ArchiveName(version, goos, goarch)
	mux := http.NewServeMux()
	mux.HandleFunc("/"+ChecksumFileName, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, checksumBody)
	})
	mux.HandleFunc("/"+archive, func(w http.ResponseWriter, r *http.Request) {
		if archiveStatus != http.StatusOK {
			w.WriteHeader(archiveStatus)
			return
		}
		_, _ = w.Write(archiveBody)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func TestRecovery_ChecksumMismatchLeavesDest(t *testing.T) {
	version := "0.9.0"
	goos, goarch := "linux", "amd64"
	archive := ArchiveName(version, goos, goarch)
	payload := gzipTarWithFile(t, "herdr-workflows", []byte("release-bin"))
	checksumBody := "0000000000000000000000000000000000000000000000000000000000000000  " + archive + "\n"
	srv := recoveryServer(t, version, goos, goarch, checksumBody, http.StatusOK, payload)
	dest := seedDest(t)

	err := InstallRelease(InstallOpts{
		Version:  version,
		GOOS:     goos,
		GOARCH:   goarch,
		DestPath: dest,
		BaseURL:  srv.URL,
		Client:   srv.Client(),
	})
	if err == nil {
		t.Fatal("expected checksum mismatch")
	}
	assertDestUnchanged(t, dest)
}

func TestRecovery_ArchiveHTTP404LeavesDest(t *testing.T) {
	version := "0.9.0"
	goos, goarch := "linux", "amd64"
	archive := ArchiveName(version, goos, goarch)
	sum := sha256.Sum256([]byte("x"))
	checksumBody := hex.EncodeToString(sum[:]) + "  " + archive + "\n"
	srv := recoveryServer(t, version, goos, goarch, checksumBody, http.StatusNotFound, nil)
	dest := seedDest(t)

	err := InstallRelease(InstallOpts{
		Version:  version,
		GOOS:     goos,
		GOARCH:   goarch,
		DestPath: dest,
		BaseURL:  srv.URL,
		Client:   srv.Client(),
	})
	if err == nil {
		t.Fatal("expected archive HTTP 404")
	}
	assertDestUnchanged(t, dest)
}

func TestRecovery_ChecksumsHTTP404LeavesDest(t *testing.T) {
	version := "0.9.0"
	goos, goarch := "linux", "amd64"
	archive := ArchiveName(version, goos, goarch)
	payload := gzipTarWithFile(t, "herdr-workflows", []byte("release-bin"))
	mux := http.NewServeMux()
	mux.HandleFunc("/"+ChecksumFileName, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})
	mux.HandleFunc("/"+archive, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(payload)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	dest := seedDest(t)

	err := InstallRelease(InstallOpts{
		Version:  version,
		GOOS:     goos,
		GOARCH:   goarch,
		DestPath: dest,
		BaseURL:  srv.URL,
		Client:   srv.Client(),
	})
	if err == nil {
		t.Fatal("expected checksums HTTP 404")
	}
	assertDestUnchanged(t, dest)
}

func TestRecovery_MissingChecksumEntryLeavesDest(t *testing.T) {
	version := "0.9.0"
	goos, goarch := "linux", "amd64"
	payload := gzipTarWithFile(t, "herdr-workflows", []byte("release-bin"))
	sum := sha256.Sum256(payload)
	checksumBody := hex.EncodeToString(sum[:]) + "  other-archive.tar.gz\n"
	srv := recoveryServer(t, version, goos, goarch, checksumBody, http.StatusOK, payload)
	dest := seedDest(t)

	err := InstallRelease(InstallOpts{
		Version:  version,
		GOOS:     goos,
		GOARCH:   goarch,
		DestPath: dest,
		BaseURL:  srv.URL,
		Client:   srv.Client(),
	})
	if err == nil {
		t.Fatal("expected missing checksum entry")
	}
	if !strings.Contains(err.Error(), "no entry") {
		t.Fatalf("error = %q, want no entry", err)
	}
	assertDestUnchanged(t, dest)
}

func TestRecovery_ArchiveMissingBinaryLeavesDest(t *testing.T) {
	version := "0.9.0"
	goos, goarch := "linux", "amd64"
	archive := ArchiveName(version, goos, goarch)
	payload := gzipTarWithFile(t, "not-the-binary", []byte("wrong-member"))
	sum := sha256.Sum256(payload)
	checksumBody := hex.EncodeToString(sum[:]) + "  " + archive + "\n"
	srv := recoveryServer(t, version, goos, goarch, checksumBody, http.StatusOK, payload)
	dest := seedDest(t)

	err := InstallRelease(InstallOpts{
		Version:  version,
		GOOS:     goos,
		GOARCH:   goarch,
		DestPath: dest,
		BaseURL:  srv.URL,
		Client:   srv.Client(),
	})
	if err == nil {
		t.Fatal("expected missing archive member")
	}
	if !strings.Contains(err.Error(), "archive missing") {
		t.Fatalf("error = %q, want archive missing", err)
	}
	assertDestUnchanged(t, dest)
}

func TestRecovery_SuccessfulInstallOverwritesDest(t *testing.T) {
	version := "0.9.0"
	goos, goarch := "linux", "amd64"
	archive := ArchiveName(version, goos, goarch)
	payload := gzipTarWithFile(t, "herdr-workflows", []byte("release-bin"))
	sum := sha256.Sum256(payload)
	checksumBody := hex.EncodeToString(sum[:]) + "  " + archive + "\n"
	srv := recoveryServer(t, version, goos, goarch, checksumBody, http.StatusOK, payload)
	dest := seedDest(t)

	err := InstallRelease(InstallOpts{
		Version:  version,
		GOOS:     goos,
		GOARCH:   goarch,
		DestPath: dest,
		BaseURL:  srv.URL,
		Client:   srv.Client(),
	})
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "release-bin" {
		t.Fatalf("dest = %q, want release-bin", got)
	}
}

func TestRecovery_WSL2SelectsLinuxArtifact(t *testing.T) {
	osName, arch, err := SelectArtifact("linux", "amd64")
	if err != nil {
		t.Fatal(err)
	}
	if osName != "linux" || arch != "amd64" {
		t.Fatalf("SelectArtifact(linux, amd64) = %q, %q", osName, arch)
	}
}
