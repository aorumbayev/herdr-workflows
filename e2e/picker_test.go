package e2e_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/host"
)

func listenE2EPing(t *testing.T, protocol int, version string) string {
	t.Helper()
	sockPath := filepath.Join("/tmp", fmt.Sprintf("hwf-e2e-picker-%d-%d.sock", os.Getpid(), time.Now().UnixNano()))
	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = ln.Close()
		_ = os.Remove(sockPath)
	})
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer func() { _ = c.Close() }()
				buf := make([]byte, 4096)
				n, _ := c.Read(buf)
				var req struct {
					ID string `json:"id"`
				}
				_ = json.Unmarshal(buf[:n], &req)
				resp := fmt.Sprintf(`{"id":%q,"result":{"type":"pong","protocol":%d,"version":%q}}`+"\n",
					req.ID, protocol, version)
				_, _ = c.Write([]byte(resp))
			}(conn)
		}
	}()
	return sockPath
}

func TestCompiledBinaryPickerRequiresTTY(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".hwf", "workflows"), 0o755); err != nil {
		t.Fatal(err)
	}
	sock := listenE2EPing(t, host.Protocol, host.MinHerdrVersion)

	cmd := exec.Command(hwfBinary, "picker")
	cmd.Dir = root
	env := map[string]string{
		"HERDR_WORKFLOWS_REPO_ROOT": root,
		"HERDR_SOCKET_PATH":         sock,
		"HERDR_PLUGIN_CONFIG_DIR":   t.TempDir(),
		"HERDR_PLUGIN_STATE_DIR":    t.TempDir(),
		"PATH":                      "/usr/bin:/bin",
	}
	cmd.Env = e2eFlatEnv(env)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err == nil {
		t.Fatal("picker exited 0 without a tty")
	}
	ee, ok := err.(*exec.ExitError)
	if !ok || ee.ExitCode() != 1 {
		t.Fatalf("err = %v stderr = %q", err, stderr.String())
	}
	if !strings.Contains(stderr.String(), "picker requires a tty") {
		t.Fatalf("stderr = %q", stderr.String())
	}
}

func TestCompiledBinaryPickerEmbedsWithoutTSHooks(t *testing.T) {
	data, err := os.ReadFile(hwfBinary)
	if err != nil {
		t.Fatal(err)
	}
	body := string(data)
	for _, want := range []string{"picker requires a tty", "tab | enter run | ctrl+k | esc"} {
		if !strings.Contains(body, want) {
			t.Fatalf("missing %q", want)
		}
	}
	for _, forbidden := range []string{"#!/usr/bin/env bun", "bun run picker", "node_modules/.bin/tsx"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("TS runtime hook %q", forbidden)
		}
	}
}

func e2eFlatEnv(extra map[string]string) []string {
	out := make([]string, 0, len(os.Environ())+len(extra))
	seen := map[string]bool{}
	for key, val := range extra {
		out = append(out, key+"="+val)
		seen[key] = true
	}
	for _, e := range os.Environ() {
		key, _, _ := strings.Cut(e, "=")
		if seen[key] {
			continue
		}
		switch key {
		case "HERDR_SOCKET_PATH", "HERDR_PLUGIN_CONTEXT_JSON", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID":
			continue
		}
		out = append(out, e)
	}
	return out
}
