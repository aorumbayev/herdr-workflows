package cli

import (
	"strings"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/host"
)

func TestConsolePlacementOpensPluginPane(t *testing.T) {
	root := t.TempDir()
	var placement string
	var direction string
	var entrypoint string
	sockPath := listenHerdrRPC(t, func(method string, params map[string]any) {
		if method != "plugin.pane.open" {
			return
		}
		if v, ok := params["placement"].(string); ok {
			placement = v
		}
		if v, ok := params["direction"].(string); ok {
			direction = v
		}
		if v, ok := params["entrypoint"].(string); ok {
			entrypoint = v
		}
	})
	got := runCLI([]string{"console", "--placement", "beside"}, root, testCLIEnv(t, map[string]string{
		"HERDR_SOCKET_PATH": sockPath,
	}), "")
	if got.code != 0 {
		t.Fatalf("code = %d stderr = %q", got.code, got.stderr)
	}
	if entrypoint != "console" {
		t.Fatalf("entrypoint = %q", entrypoint)
	}
	if placement != "split" || direction != "right" {
		t.Fatalf("placement=%q direction=%q", placement, direction)
	}
	_ = host.Protocol
}

func TestConsoleRequiresTTYWithoutPlacement(t *testing.T) {
	got := runCLI([]string{"console"}, t.TempDir(), testCLIEnv(t, nil), "")
	if got.code == 0 {
		t.Fatal("expected nonzero")
	}
	if !strings.Contains(got.stderr, "console requires a tty") {
		t.Fatalf("stderr = %q", got.stderr)
	}
}
