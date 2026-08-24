package host

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
)

var semverRE = regexp.MustCompile(`^(\d+)\.(\d+)\.(\d+)([-+].*)?$`)

func parseSemver(v string) (major, minor, patch int, ok bool) {
	m := semverRE.FindStringSubmatch(strings.TrimSpace(v))
	if m == nil {
		return 0, 0, 0, false
	}
	major, err := strconv.Atoi(m[1])
	if err != nil {
		return 0, 0, 0, false
	}
	minor, err = strconv.Atoi(m[2])
	if err != nil {
		return 0, 0, 0, false
	}
	patch, err = strconv.Atoi(m[3])
	if err != nil {
		return 0, 0, 0, false
	}
	return major, minor, patch, true
}

func versionAtLeast(live, minimum string) bool {
	lm, ln, lp, lok := parseSemver(live)
	mm, mn, mp, mok := parseSemver(minimum)
	if !lok || !mok {
		return false
	}
	if lm != mm {
		return lm > mm
	}
	if ln != mn {
		return ln > mn
	}
	return lp >= mp
}

// StartupResult is the result of a comparison of a live herdr ping with the
// pinned protocol and the minimum version in the manifest.
type StartupResult struct {
	Ok       bool
	Protocol int
	Version  string
	Error    string
}

func finiteProtocol(v any) (float64, bool) {
	n, ok := v.(float64)
	if !ok {
		return 0, false
	}
	return n, !math.IsInf(n, 0) && !math.IsNaN(n)
}

func renderProtocolValue(v any) string {
	if v == nil {
		return "null"
	}
	return fmt.Sprint(v)
}

func formatProtocol(p float64) string {
	if p == math.Trunc(p) {
		return strconv.FormatInt(int64(p), 10)
	}
	return strconv.FormatFloat(p, 'f', -1, 64)
}

// CheckHerdrStartup compares the protocol and version from a live ping with the
// pinned protocol and the minimum version in the manifest.
func CheckHerdrStartup(protocol any, version any) StartupResult {
	installed := "missing"
	versionStr, versionIsString := version.(string)
	if versionIsString {
		installed = versionStr
	}
	proto, protoIsNumber := finiteProtocol(protocol)
	if !protoIsNumber {
		return StartupResult{
			Error: fmt.Sprintf("herdr protocol check failed: ping did not return a protocol number (installed=%s, required≥%s; protocol connected=%s, pinned=%d)",
				installed, MinHerdrVersion, renderProtocolValue(protocol), Protocol),
		}
	}
	_, _, _, semverOK := parseSemver(versionStr)
	if !versionIsString || !semverOK {
		return StartupResult{
			Error: fmt.Sprintf("herdr version check failed: ping did not return a semver version (installed=%s, required≥%s; protocol connected=%s, pinned=%d)",
				installed, MinHerdrVersion, formatProtocol(proto), Protocol),
		}
	}
	if !versionAtLeast(versionStr, MinHerdrVersion) {
		return StartupResult{
			Error: fmt.Sprintf("herdr version too old: installed=%s, required≥%s; protocol connected=%s, pinned=%d",
				versionStr, MinHerdrVersion, formatProtocol(proto), Protocol),
		}
	}
	if proto != float64(Protocol) {
		return StartupResult{
			Error: fmt.Sprintf("herdr protocol mismatch: connected=%s, pinned=%d (installed=%s, required≥%s)",
				formatProtocol(proto), Protocol, versionStr, MinHerdrVersion),
		}
	}
	return StartupResult{Ok: true, Protocol: int(proto), Version: versionStr}
}
