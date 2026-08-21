package update

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestInstallReleaseExtractsVerifiedBinary(t *testing.T) {
	version := "0.9.0"
	goos, goarch, err := SelectArtifact(runtime.GOOS, runtime.GOARCH)
	if err != nil {
		t.Skip(err)
	}
	archive := ArchiveName(version, goos, goarch)
	payload := gzipTarWithFile(t, "herdr-workflows", []byte("release-bin"))
	sum := sha256.Sum256(payload)
	checksumBody := hex.EncodeToString(sum[:]) + "  " + archive + "\n"

	mux := http.NewServeMux()
	mux.HandleFunc("/"+ChecksumFileName, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, checksumBody)
	})
	mux.HandleFunc("/"+archive, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(payload)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	destDir := t.TempDir()
	dest := filepath.Join(destDir, "herdr-workflows")
	err = InstallRelease(InstallOpts{
		Version:  version,
		GOOS:     runtime.GOOS,
		GOARCH:   runtime.GOARCH,
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
		t.Fatalf("dest = %q", got)
	}
}

func TestInstallReleaseChecksumMismatchLeavesDest(t *testing.T) {
	version := "0.9.0"
	goos, goarch, err := SelectArtifact(runtime.GOOS, runtime.GOARCH)
	if err != nil {
		t.Skip(err)
	}
	archive := ArchiveName(version, goos, goarch)
	payload := gzipTarWithFile(t, "herdr-workflows", []byte("release-bin"))
	checksumBody := "0000000000000000000000000000000000000000000000000000000000000000  " + archive + "\n"

	mux := http.NewServeMux()
	mux.HandleFunc("/"+ChecksumFileName, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, checksumBody)
	})
	mux.HandleFunc("/"+archive, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(payload)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	destDir := t.TempDir()
	dest := filepath.Join(destDir, "herdr-workflows")
	if err := os.WriteFile(dest, []byte("prior"), 0o755); err != nil {
		t.Fatal(err)
	}
	err = InstallRelease(InstallOpts{
		Version:  version,
		GOOS:     runtime.GOOS,
		GOARCH:   runtime.GOARCH,
		DestPath: dest,
		BaseURL:  srv.URL,
		Client:   srv.Client(),
	})
	if err == nil {
		t.Fatal("expected checksum failure")
	}
	got, readErr := os.ReadFile(dest)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(got) != "prior" {
		t.Fatalf("dest overwritten: %q", got)
	}
}

func TestInstallReleaseDownloadFailureLeavesDest(t *testing.T) {
	version := "0.9.0"
	goos, goarch, err := SelectArtifact(runtime.GOOS, runtime.GOARCH)
	if err != nil {
		t.Skip(err)
	}
	archive := ArchiveName(version, goos, goarch)
	mux := http.NewServeMux()
	mux.HandleFunc("/"+ChecksumFileName, func(w http.ResponseWriter, r *http.Request) {
		sum := sha256.Sum256([]byte("x"))
		_, _ = fmt.Fprintf(w, "%s  %s\n", hex.EncodeToString(sum[:]), archive)
	})
	mux.HandleFunc("/"+archive, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	destDir := t.TempDir()
	dest := filepath.Join(destDir, "herdr-workflows")
	if err := os.WriteFile(dest, []byte("prior"), 0o755); err != nil {
		t.Fatal(err)
	}
	err = InstallRelease(InstallOpts{
		Version:  version,
		GOOS:     runtime.GOOS,
		GOARCH:   runtime.GOARCH,
		DestPath: dest,
		BaseURL:  srv.URL,
		Client:   srv.Client(),
	})
	if err == nil {
		t.Fatal("expected download failure")
	}
	got, readErr := os.ReadFile(dest)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(got) != "prior" {
		t.Fatalf("dest overwritten: %q", got)
	}
}

func gzipTarWithFile(t *testing.T, name string, body []byte) []byte {
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
