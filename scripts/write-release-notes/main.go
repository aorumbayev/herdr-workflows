// Command write-release-notes writes GitHub release notes from CHANGELOG and the
// verified-archive install footer for remote Herdr installs.
//
// Usage: CHANGELOG_JSON=… go run ./scripts/write-release-notes <dest>
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

const footer = "### Install requirements\n\nRemote install via Herdr downloads the verified release archive. The target host does not need Go."

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) != 1 || args[0] == "" {
		return fmt.Errorf("write-release-notes: dest path required")
	}
	changelog, err := changelogText()
	if err != nil {
		return err
	}
	var b strings.Builder
	if strings.TrimSpace(changelog) != "" {
		b.WriteString(changelog)
		if !strings.HasSuffix(changelog, "\n") {
			b.WriteByte('\n')
		}
		b.WriteByte('\n')
	}
	b.WriteString(footer)
	b.WriteByte('\n')
	return os.WriteFile(args[0], []byte(b.String()), 0o644)
}

func changelogText() (string, error) {
	if raw, ok := os.LookupEnv("CHANGELOG_JSON"); ok {
		if strings.TrimSpace(raw) == "" || raw == "null" {
			return "", nil
		}
		var notes string
		if err := json.Unmarshal([]byte(raw), &notes); err != nil {
			return "", fmt.Errorf("write-release-notes: CHANGELOG_JSON: %w", err)
		}
		return notes, nil
	}
	return os.Getenv("CHANGELOG"), nil
}
