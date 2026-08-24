package cli

import (
	"strings"
	"testing"
)

func TestEditorRequiresFile(t *testing.T) {
	got := runCLI([]string{"editor"}, t.TempDir(), testCLIEnv(t, nil), "")
	if got.code == 0 {
		t.Fatal("expected nonzero")
	}
	if !strings.Contains(got.stderr, "HWF_EDITOR_FILE") {
		t.Fatalf("stderr = %q", got.stderr)
	}
}
