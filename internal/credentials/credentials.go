// Package credentials does permission-bits checks of the private credential store
// and best-effort ACL removal and inspection.
package credentials

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	osuser "os/user"
	"regexp"
	"runtime"
	"strconv"
	"strings"
)

// StoreError identifies a credential store that is not shown to be private.
type StoreError struct {
	msg string
}

func (e *StoreError) Error() string { return e.msg }

// ACLGrant is one parsed access-control entry.
type ACLGrant struct {
	Principal string
	Allow     bool
}

// Options inject seams for tests. Nil fields use the real filesystem and OS.
type Options struct {
	Chmod    func(string, os.FileMode) error
	Stat     func(string) (os.FileMode, error)
	MkdirAll func(string, os.FileMode) error
	StripACL func(string)
	ReadACL  func(string) []ACLGrant
	UID      func() int
}

type ops struct {
	chmod    func(string, os.FileMode) error
	stat     func(string) (os.FileMode, error)
	mkdirAll func(string, os.FileMode) error
	stripACL func(string)
	readACL  func(string) []ACLGrant
	uid      func() int
}

func resolve(o *Options) ops {
	resolved := ops{
		chmod:    os.Chmod,
		mkdirAll: os.MkdirAll,
		stripACL: stripExtendedACLs,
		readACL:  readExtendedACLs,
		uid:      os.Getuid,
		stat: func(path string) (os.FileMode, error) {
			info, err := os.Stat(path)
			if err != nil {
				return 0, err
			}
			return info.Mode(), nil
		},
	}
	if o == nil {
		return resolved
	}
	if o.Chmod != nil {
		resolved.chmod = o.Chmod
	}
	if o.Stat != nil {
		resolved.stat = o.Stat
	}
	if o.MkdirAll != nil {
		resolved.mkdirAll = o.MkdirAll
	}
	if o.StripACL != nil {
		resolved.stripACL = o.StripACL
	}
	if o.ReadACL != nil {
		resolved.readACL = o.ReadACL
	}
	if o.UID != nil {
		resolved.uid = o.UID
	}
	return resolved
}

func runQuiet(name string, args ...string) (stdout string, status int, missing bool) {
	cmd := exec.Command(name, args...)
	out, err := cmd.Output()
	if err == nil {
		return string(out), 0, false
	}
	if errors.Is(err, exec.ErrNotFound) {
		return "", 0, true
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return string(out), exitErr.ExitCode(), false
	}
	return "", 1, false
}

func stripExtendedACLs(path string) {
	switch runtime.GOOS {
	case "darwin":
		runQuiet("/bin/chmod", "-N", path)
	case "linux":
		runQuiet("setfacl", "-b", path)
	}
}

var darwinAclRE = regexp.MustCompile(`^\s*\d+:\s+(\S+)(?:\s+inherited)?\s+(allow|deny)\s+`)

// ParseDarwinACLListing parses numbered ACE lines from macOS `/bin/ls -lde` /
// `-le` into grants.
func ParseDarwinACLListing(stdout string) []ACLGrant {
	var grants []ACLGrant
	for line := range strings.Lines(stdout) {
		m := darwinAclRE.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		grants = append(grants, ACLGrant{Principal: m[1], Allow: m[2] == "allow"})
	}
	return grants
}

var linuxAclRE = regexp.MustCompile(`^(user|group|other|mask):([^:]*):([rwx-]+)`)

// ParseLinuxACLListing parses named entries from `getfacl -cp`. Blank owning
// user: and group: fields are mode bits, not ACEs.
func ParseLinuxACLListing(stdout string) []ACLGrant {
	var grants []ACLGrant
	for line := range strings.Lines(stdout) {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		m := linuxAclRE.FindStringSubmatch(trimmed)
		if m == nil {
			continue
		}
		kind, name, perms := m[1], m[2], m[3]
		if perms == "---" || kind == "mask" || kind == "other" {
			continue
		}
		if (kind == "user" || kind == "group") && name == "" {
			continue
		}
		grants = append(grants, ACLGrant{Principal: kind + ":" + name, Allow: true})
	}
	return grants
}

// readExtendedACLs gives nil if the platform cannot give ACL data.
func readExtendedACLs(path string) []ACLGrant {
	switch runtime.GOOS {
	case "darwin":
		listed, status, _ := runQuiet("/bin/ls", "-lde", path)
		if status != 0 {
			listed, status, _ = runQuiet("/bin/ls", "-le", path)
			if status != 0 {
				return nil
			}
		}
		return ParseDarwinACLListing(listed)
	case "linux":
		listed, status, missing := runQuiet("getfacl", "-cp", path)
		if missing || status != 0 {
			return nil
		}
		return ParseLinuxACLListing(listed)
	}
	return nil
}

func ownerPrincipalHints(uid int) map[string]bool {
	hints := map[string]bool{
		"owner": true, "owner@": true,
		"user:" + strconv.Itoa(uid): true,
	}
	if u, err := osuser.Current(); err == nil && u.Username != "" {
		hints[u.Username] = true
		hints["user:"+u.Username] = true
	}
	return hints
}

func assertModePrivate(path string, mode os.FileMode, kind string) error {
	if mode&0o077 != 0 {
		return &StoreError{msg: fmt.Sprintf("refusing credential %s with group/world access: %s", kind, path)}
	}
	return nil
}

func assertNoForeignACLAccess(path string, o ops) error {
	o.stripACL(path)
	grants := o.readACL(path)
	if grants == nil {
		return nil
	}
	hints := ownerPrincipalHints(o.uid())
	for _, grant := range grants {
		if grant.Allow && !hints[grant.Principal] {
			return &StoreError{msg: fmt.Sprintf("refusing credential store with foreign ACL grant at %s", path)}
		}
	}
	return nil
}

// AssertCredentialStoreSafe makes sure that stateDir is private to the current user.
// The check occurs before a write of run-history snapshots (captured command output and transcript text).
//
// Mode bits and ACL removal are for POSIX discretionary access and usual ACL inheritance.
// A filesystem with no permission model (some network mounts) has no proof of safety.
// The function rejects only the conditions that the platform can observe.
func AssertCredentialStoreSafe(stateDir string, opts *Options) error {
	o := resolve(opts)
	if err := o.mkdirAll(stateDir, 0o700); err != nil {
		return err
	}
	if err := o.chmod(stateDir, 0o700); err != nil {
		return err
	}
	mode, err := o.stat(stateDir)
	if err != nil {
		return err
	}
	if err := assertModePrivate(stateDir, mode&0o777, "store"); err != nil {
		return err
	}
	return assertNoForeignACLAccess(stateDir, o)
}

// AssertPrivateCredentialFile tightens the mode of a credential file and makes
// sure that the file is private to the current user.
func AssertPrivateCredentialFile(path string, opts *Options) error {
	o := resolve(opts)
	if err := o.chmod(path, 0o600); err != nil {
		return err
	}
	mode, err := o.stat(path)
	if err != nil {
		return err
	}
	if err := assertModePrivate(path, mode&0o777, "file"); err != nil {
		return err
	}
	return assertNoForeignACLAccess(path, o)
}
