package update

import (
	"archive/tar"
	"compress/gzip"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

type InstallOpts struct {
	Version  string
	GOOS     string
	GOARCH   string
	DestPath string
	BaseURL  string
	Client   *http.Client
}

func ReleaseAssetURL(version, filename string) string {
	return fmt.Sprintf(
		"https://github.com/%s/releases/download/v%s/%s",
		ReleaseRepo, version, filename,
	)
}

func InstallRelease(opts InstallOpts) error {
	if opts.Version == "" || opts.DestPath == "" {
		return fmt.Errorf("version and dest path are required")
	}
	osName, arch, err := SelectArtifact(opts.GOOS, opts.GOARCH)
	if err != nil {
		return err
	}
	archive := ArchiveName(opts.Version, osName, arch)
	client := opts.Client
	if client == nil {
		client = &http.Client{Timeout: 120 * time.Second}
	}
	work, err := os.MkdirTemp("", "herdr-workflows-install-*")
	if err != nil {
		return err
	}
	defer func() { _ = os.RemoveAll(work) }()

	checksumPath := filepath.Join(work, ChecksumFileName)
	archivePath := filepath.Join(work, archive)
	if err := downloadFile(client, assetURL(opts.BaseURL, opts.Version, ChecksumFileName), checksumPath); err != nil {
		return err
	}
	if err := downloadFile(client, assetURL(opts.BaseURL, opts.Version, archive), archivePath); err != nil {
		return err
	}
	sumsRaw, err := os.ReadFile(checksumPath)
	if err != nil {
		return err
	}
	sums, err := ParseChecksums(string(sumsRaw))
	if err != nil {
		return err
	}
	want, ok := sums[archive]
	if !ok {
		return fmt.Errorf("checksums.txt has no entry for %s", archive)
	}
	if err := VerifyFile(archivePath, want); err != nil {
		return err
	}
	extracted, err := extractNamedBinary(archivePath, "herdr-workflows", work)
	if err != nil {
		return err
	}
	return ReplaceExecutable(extracted, opts.DestPath)
}

func assetURL(base, version, filename string) string {
	if strings.TrimSpace(base) == "" {
		return ReleaseAssetURL(version, filename)
	}
	return strings.TrimRight(base, "/") + "/" + filename
}

func downloadFile(client *http.Client, url, dest string) error {
	resp, err := client.Get(url)
	if err != nil {
		return fmt.Errorf("download %s: %w", url, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download %s: HTTP %d", url, resp.StatusCode)
	}
	f, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	if _, err := io.Copy(f, resp.Body); err != nil {
		return err
	}
	return f.Sync()
}

func extractNamedBinary(archivePath, wantName, destDir string) (string, error) {
	f, err := os.Open(archivePath)
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return "", err
	}
	defer func() { _ = gz.Close() }()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", err
		}
		if hdr.Typeflag != tar.TypeReg {
			continue
		}
		base := path.Base(hdr.Name)
		if base != wantName {
			continue
		}
		out := filepath.Join(destDir, wantName)
		w, err := os.OpenFile(out, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
		if err != nil {
			return "", err
		}
		if _, err := io.Copy(w, tr); err != nil {
			_ = w.Close()
			return "", err
		}
		if err := w.Sync(); err != nil {
			_ = w.Close()
			return "", err
		}
		if err := w.Close(); err != nil {
			return "", err
		}
		return out, nil
	}
	return "", fmt.Errorf("archive missing %s", wantName)
}
