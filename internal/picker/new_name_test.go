package picker

import (
	"strings"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/tui"
)

func TestNewNameHintUsesASCIIChrome(t *testing.T) {
	m := New(Options{Width: 60, Height: 24})
	m.mode = modeNewName
	body := m.View().Content
	if !strings.Contains(body, tui.CreateNameHint) {
		t.Fatalf("missing create-name hint: %q", body)
	}
	if strings.Contains(body, "·") {
		t.Fatalf("create-name hint must not use middle dot: %q", body)
	}
}
