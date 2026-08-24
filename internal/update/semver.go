package update

import (
	"fmt"
	"strings"
)

type ReleaseCheckError struct {
	msg string
	err error
}

func (e *ReleaseCheckError) Error() string { return e.msg }

func (e *ReleaseCheckError) Unwrap() error { return e.err }

func releaseErr(msg string) error { return &ReleaseCheckError{msg: msg} }

func releaseWrap(msg string, err error) error {
	return &ReleaseCheckError{msg: msg + ": " + err.Error(), err: err}
}

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
	var minor, patch int
	n, err := fmt.Sscanf(version, "0.%d.%d", &minor, &patch)
	if err != nil || n != 2 || !strings.HasPrefix(version, "0.") {
		return [3]int{}, releaseErr(fmt.Sprintf("expected 0.x.y version, got %q", version))
	}
	// The parsed text must equal 0.x.y. An extra suffix such as 0.2.3-beta fails.
	if fmt.Sprintf("0.%d.%d", minor, patch) != version {
		return [3]int{}, releaseErr(fmt.Sprintf("expected 0.x.y version, got %q", version))
	}
	return [3]int{0, minor, patch}, nil
}
