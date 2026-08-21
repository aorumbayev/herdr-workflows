package credentials

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func TestAssertCredentialStoreSafeAcceptsUserOnlyDir(t *testing.T) {
	if err := AssertCredentialStoreSafe(t.TempDir(), nil); err != nil {
		t.Fatal(err)
	}
}

func TestRefusesDirectoryGroupWorldAccessibleAfterTighten(t *testing.T) {
	dir := t.TempDir()
	opts := &Options{
		Chmod:    func(string, os.FileMode) error { return nil },
		Stat:     func(string) (os.FileMode, error) { return 0o755, nil },
		StripACL: func(string) {},
		ReadACL:  func(string) []ACLGrant { return []ACLGrant{} },
	}
	err := AssertCredentialStoreSafe(dir, opts)
	if err == nil {
		t.Fatal("expected refusal")
	}
	var storeErr *StoreError
	if !errors.As(err, &storeErr) {
		t.Fatalf("err type = %T", err)
	}
	if !strings.Contains(err.Error(), dir) {
		t.Fatalf("message must name the dir: %q", err.Error())
	}
}

func TestRefusesForeignACLGrantSurvivingStrip(t *testing.T) {
	dir := t.TempDir()
	opts := &Options{
		StripACL: func(string) {},
		ReadACL:  func(string) []ACLGrant { return []ACLGrant{{Principal: "group:everyone", Allow: true}} },
	}
	err := AssertCredentialStoreSafe(dir, opts)
	if err == nil || !strings.Contains(err.Error(), "foreign ACL grant") ||
		!strings.Contains(err.Error(), dir) {
		t.Fatalf("err = %v", err)
	}
}

func TestAcceptsOwnerOnlyACLGrantsAfterStrip(t *testing.T) {
	dir := t.TempDir()
	opts := &Options{
		StripACL: func(string) {},
		ReadACL:  func(string) []ACLGrant { return []ACLGrant{{Principal: "owner", Allow: true}} },
		UID:      func() int { return 501 },
	}
	if err := AssertCredentialStoreSafe(dir, opts); err != nil {
		t.Fatal(err)
	}
}

func TestDenyGrantsNeverRefuse(t *testing.T) {
	dir := t.TempDir()
	opts := &Options{
		StripACL: func(string) {},
		ReadACL: func(string) []ACLGrant {
			return []ACLGrant{{Principal: "group:everyone", Allow: false}}
		},
		UID: func() int { return 501 },
	}
	if err := AssertCredentialStoreSafe(dir, opts); err != nil {
		t.Fatal(err)
	}
}

func TestParseDarwinACLListing(t *testing.T) {
	grants := ParseDarwinACLListing(`drwx------@ 2 user  staff  64 Jan 1 00:00 /tmp/x
 0: group:everyone inherited allow list,add_file,search,delete
 1: user:alice allow read,write
 2: user:eve deny read
`)
	want := []ACLGrant{
		{Principal: "group:everyone", Allow: true},
		{Principal: "user:alice", Allow: true},
		{Principal: "user:eve", Allow: false},
	}
	if !reflect.DeepEqual(grants, want) {
		t.Fatalf("grants = %+v, want %+v", grants, want)
	}
}

func TestParseLinuxACLListing(t *testing.T) {
	grants := ParseLinuxACLListing(`# file: x
user::rwx
user:bob:rwx
group::r-x
group:staff:r--
mask::rwx
other::---
`)
	want := []ACLGrant{
		{Principal: "user:bob", Allow: true},
		{Principal: "group:staff", Allow: true},
	}
	if !reflect.DeepEqual(grants, want) {
		t.Fatalf("grants = %+v, want %+v", grants, want)
	}
}

func TestAssertPrivateCredentialFileTightensMode(t *testing.T) {
	path := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(path, []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := AssertPrivateCredentialFile(path, nil); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if mode := info.Mode() & 0o777; mode != 0o600 {
		t.Fatalf("mode = %o, want 600", mode)
	}
}

func TestDarwinInheritedACLRefusal(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("darwin-only ACL behavior")
	}
	parent := t.TempDir()
	if _, status, _ := runQuiet("/bin/chmod",
		"+a", "everyone allow read,write,execute,delete,add_file,add_subdirectory,file_inherit,directory_inherit",
		parent); status != 0 {
		t.Fatalf("chmod +a failed with status %d", status)
	}
	listed, status, _ := runQuiet("/bin/ls", "-lde", parent)
	if status != 0 || !strings.Contains(listed, "group:everyone") {
		t.Fatalf("expected everyone ACE on parent: %s", listed)
	}
	child := filepath.Join(parent, "child")
	if _, status, _ := runQuiet("/bin/mkdir", "-m", "700", child); status != 0 {
		t.Fatalf("mkdir failed with status %d", status)
	}
	inherited, _, _ := runQuiet("/bin/ls", "-lde", child)
	if !strings.Contains(inherited, "group:everyone") || !strings.Contains(inherited, "allow") {
		t.Fatalf("expected inherited everyone allow ACE on child: %s", inherited)
	}
	if _, status, _ := runQuiet("/bin/chmod", "-N", child); status != 0 {
		t.Fatalf("chmod -N failed with status %d", status)
	}
	cleared, _, _ := runQuiet("/bin/ls", "-lde", child)
	for line := range strings.Lines(cleared) {
		if darwinAclRE.MatchString(line) {
			t.Fatalf("chmod -N must clear ACEs: %s", cleared)
		}
	}
	err := AssertCredentialStoreSafe(filepath.Join(parent, "state"), &Options{
		StripACL: func(string) {},
		ReadACL:  func(string) []ACLGrant { return []ACLGrant{{Principal: "group:everyone", Allow: true}} },
	})
	if err == nil || !strings.Contains(err.Error(), filepath.Join(parent, "state")) {
		t.Fatalf("mode-only check would accept; foreign ACL must refuse: %v", err)
	}
}
