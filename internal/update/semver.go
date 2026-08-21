package update

import (
	"fmt"
	"strings"
)

type ReleaseCheckError struct {
	msg string
}

func (e *ReleaseCheckError) Error() string { return e.msg }

func releaseErr(msg string) error { return &ReleaseCheckError{msg: msg} }

type LatestRelease struct {
	Tag     string
	Version string
}

func ParseReleaseTag(tag string) (LatestRelease, error) {
	tag = strings.TrimSpace(tag)
	if len(tag) < 2 || tag[0] != 'v' {
		return LatestRelease{}, releaseErr(fmt.Sprintf("latest release tag is not a strict v0.x.y semver: %q", tag))
	}
	ver := tag[1:]
	if _, err := parseParts(ver); err != nil {
		return LatestRelease{}, releaseErr(fmt.Sprintf("latest release tag is not a strict v0.x.y semver: %q", tag))
	}
	return LatestRelease{Tag: "v" + ver, Version: ver}, nil
}

func CompareSemver(a, b string) (int, error) {
	pa, err := parseParts(a)
	if err != nil {
		return 0, err
	}
	pb, err := parseParts(b)
	if err != nil {
		return 0, err
	}
	for i := range 3 {
		if pa[i] != pb[i] {
			if pa[i] < pb[i] {
				return -1, nil
			}
			return 1, nil
		}
	}
	return 0, nil
}

func parseParts(version string) ([3]int, error) {
	version = strings.TrimSpace(version)
	var major, minor, patch int
	n, err := fmt.Sscanf(version, "0.%d.%d", &minor, &patch)
	if err != nil || n != 2 || !strings.HasPrefix(version, "0.") {
		return [3]int{}, releaseErr(fmt.Sprintf("expected 0.x.y version, got %q", version))
	}
	// reject extra suffix like 0.2.3-beta by requiring exact round-trip
	if fmt.Sprintf("0.%d.%d", minor, patch) != version {
		return [3]int{}, releaseErr(fmt.Sprintf("expected 0.x.y version, got %q", version))
	}
	_ = major
	return [3]int{0, minor, patch}, nil
}
