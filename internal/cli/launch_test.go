package cli

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/aorumbayev/herdr-workflows/internal/host"
)

func TestLaunchRejectsProtocolMismatch(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".hwf", "workflows"), 0o755); err != nil {
		t.Fatal(err)
	}
	sockPath := listenPingSocket(t, host.Protocol+1, host.MinHerdrVersion)
	got := runCLI([]string{"launch"}, root, testCLIEnv(t, map[string]string{
		"HERDR_SOCKET_PATH": sockPath,
	}), "")
	if got.code != 1 {
		t.Fatalf("code = %d stderr = %q", got.code, got.stderr)
	}
	if !strings.Contains(got.stderr, "herdr protocol mismatch") {
		t.Fatalf("stderr = %q", got.stderr)
	}
	if !strings.Contains(got.stderr, "pinned="+strconv.Itoa(host.Protocol)) {
		t.Fatalf("stderr = %q", got.stderr)
	}
}

func TestLaunchForwardsRepoRootAndPluginContext(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".hwf", "workflows"), 0o755); err != nil {
		t.Fatal(err)
	}
	var methods []string
	var openedEnv map[string]string
	sockPath := listenHerdrRPC(t, func(method string, params map[string]any) {
		methods = append(methods, method)
		if method != "plugin.pane.open" {
			return
		}
		raw, ok := params["env"].(map[string]any)
		if !ok {
			return
		}
		openedEnv = map[string]string{}
		for key, val := range raw {
			if s, ok := val.(string); ok {
				openedEnv[key] = s
			}
		}
	})
	ctx := `{"focused_pane_cwd":"` + root + `","selected_text":"sel"}`
	got := runCLI([]string{"launch"}, root, testCLIEnv(t, map[string]string{
		"HERDR_SOCKET_PATH":         sockPath,
		"HERDR_PLUGIN_CONTEXT_JSON": ctx,
	}), "")
	if got.code != 0 {
		t.Fatalf("code = %d stderr = %q stdout = %q", got.code, got.stderr, got.stdout)
	}
	if len(methods) != 2 || methods[0] != "ping" || methods[1] != "plugin.pane.open" {
		t.Fatalf("methods = %#v", methods)
	}
	if openedEnv["HERDR_WORKFLOWS_REPO_ROOT"] != root {
		t.Fatalf("opened env = %#v", openedEnv)
	}
	if openedEnv["HERDR_PLUGIN_CONTEXT_JSON"] != ctx {
		t.Fatalf("opened env = %#v", openedEnv)
	}
}
