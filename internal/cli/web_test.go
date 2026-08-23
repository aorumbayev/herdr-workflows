package cli

import "testing"

func TestWebCommandRemoved(t *testing.T) {
	root := newRoot()
	for _, c := range root.Commands() {
		if c.Name() == "web" {
			t.Fatal("root must not register web after workbench deletion")
		}
	}
}
