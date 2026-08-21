package update_test

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/update"
)

func TestChecksumFileName(t *testing.T) {
	if update.ChecksumFileName != "checksums.txt" {
		t.Fatalf("ChecksumFileName = %q", update.ChecksumFileName)
	}
}

func TestArchiveName(t *testing.T) {
	got := update.ArchiveName("0.8.2", "linux", "amd64")
	want := "herdr-workflows_0.8.2_linux_amd64.tar.gz"
	if got != want {
		t.Fatalf("ArchiveName = %q, want %q", got, want)
	}
}

func TestArchiveNameSupportedSet(t *testing.T) {
	version := "1.2.3"
	want := []string{
		"herdr-workflows_1.2.3_linux_amd64.tar.gz",
		"herdr-workflows_1.2.3_linux_arm64.tar.gz",
		"herdr-workflows_1.2.3_darwin_amd64.tar.gz",
		"herdr-workflows_1.2.3_darwin_arm64.tar.gz",
	}
	var got []string
	for _, osName := range []string{"linux", "darwin"} {
		for _, arch := range []string{"amd64", "arm64"} {
			got = append(got, update.ArchiveName(version, osName, arch))
		}
	}
	if len(got) != 4 {
		t.Fatalf("got %d archives, want 4", len(got))
	}
	for i, w := range want {
		if got[i] != w {
			t.Fatalf("archive[%d] = %q, want %q", i, got[i], w)
		}
	}
}

func TestSelectArtifactSupported(t *testing.T) {
	cases := []struct {
		goos, goarch, wantOS, wantArch string
	}{
		{"linux", "amd64", "linux", "amd64"},
		{"linux", "arm64", "linux", "arm64"},
		{"darwin", "amd64", "darwin", "amd64"},
		{"darwin", "arm64", "darwin", "arm64"},
	}
	for _, tc := range cases {
		osName, arch, err := update.SelectArtifact(tc.goos, tc.goarch)
		if err != nil {
			t.Fatalf("SelectArtifact(%q, %q): %v", tc.goos, tc.goarch, err)
		}
		if osName != tc.wantOS || arch != tc.wantArch {
			t.Fatalf("SelectArtifact(%q, %q) = %q, %q", tc.goos, tc.goarch, osName, arch)
		}
	}
}

func TestSelectArtifactRefusesNativeWindows(t *testing.T) {
	for _, arch := range []string{"amd64", "arm64", "386"} {
		_, _, err := update.SelectArtifact("windows", arch)
		if err == nil {
			t.Fatalf("windows/%s: expected error", arch)
		}
		if !strings.Contains(err.Error(), "native Windows") {
			t.Fatalf("windows/%s error = %q, want native Windows", arch, err)
		}
	}
}

func TestSelectArtifactUnknownPair(t *testing.T) {
	_, _, err := update.SelectArtifact("freebsd", "amd64")
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "freebsd") || !strings.Contains(err.Error(), "amd64") {
		t.Fatalf("error = %q, want pair named", err)
	}
}

func TestParseChecksums(t *testing.T) {
	text := "" +
		"abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789  herdr-workflows_0.1.0_linux_amd64.tar.gz\n" +
		"fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210  *herdr-workflows_0.1.0_darwin_arm64.tar.gz\n" +
		"# comment\n" +
		"\n"
	got, err := update.ParseChecksums(text)
	if err != nil {
		t.Fatal(err)
	}
	if got["herdr-workflows_0.1.0_linux_amd64.tar.gz"] != "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789" {
		t.Fatalf("linux amd64 = %q", got["herdr-workflows_0.1.0_linux_amd64.tar.gz"])
	}
	if got["herdr-workflows_0.1.0_darwin_arm64.tar.gz"] != "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210" {
		t.Fatalf("darwin arm64 = %q", got["herdr-workflows_0.1.0_darwin_arm64.tar.gz"])
	}
	if len(got) != 2 {
		t.Fatalf("len = %d", len(got))
	}
}

func TestParseChecksumsRejectsMalformed(t *testing.T) {
	_, err := update.ParseChecksums("not-a-checksum line\n")
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestVerifyFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "blob.bin")
	payload := []byte("hello-artifact")
	if err := os.WriteFile(path, payload, 0o644); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(payload)
	want := hex.EncodeToString(sum[:])
	if err := update.VerifyFile(path, want); err != nil {
		t.Fatal(err)
	}
	if err := update.VerifyFile(path, strings.Repeat("0", 64)); err == nil {
		t.Fatal("expected mismatch error")
	}
}

func TestVerifyFileMissing(t *testing.T) {
	err := update.VerifyFile(filepath.Join(t.TempDir(), "missing"), strings.Repeat("a", 64))
	if err == nil {
		t.Fatal("expected error")
	}
}
