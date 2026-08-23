package update

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"strings"
)

const ChecksumFileName = "checksums.txt"

func ArchiveName(version, osName, arch string) string {
	return fmt.Sprintf("herdr-workflows_%s_%s_%s.tar.gz", version, osName, arch)
}

func SelectArtifact(goos, goarch string) (osName, arch string, err error) {
	if goos == "windows" {
		return "", "", fmt.Errorf("native Windows is not supported")
	}
	switch goos {
	case "linux", "darwin":
	default:
		return "", "", fmt.Errorf("unsupported platform %s/%s", goos, goarch)
	}
	switch goarch {
	case "amd64", "arm64":
	default:
		return "", "", fmt.Errorf("unsupported platform %s/%s", goos, goarch)
	}
	return goos, goarch, nil
}

func ParseChecksums(text string) (map[string]string, error) {
	out := make(map[string]string)
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) != 2 {
			return nil, fmt.Errorf("malformed checksum line: %q", line)
		}
		sum, name := fields[0], fields[1]
		if len(sum) != 64 {
			return nil, fmt.Errorf("malformed checksum line: %q", line)
		}
		for _, c := range sum {
			if (c < '0' || c > '9') && (c < 'a' || c > 'f') && (c < 'A' || c > 'F') {
				return nil, fmt.Errorf("malformed checksum line: %q", line)
			}
		}
		name = strings.TrimPrefix(name, "*")
		if name == "" {
			return nil, fmt.Errorf("malformed checksum line: %q", line)
		}
		out[name] = strings.ToLower(sum)
	}
	return out, nil
}

func VerifyFile(path, wantHex string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(data)
	got := hex.EncodeToString(sum[:])
	want := strings.ToLower(strings.TrimSpace(wantHex))
	if got != want {
		return fmt.Errorf("checksum mismatch for %s", path)
	}
	return nil
}
