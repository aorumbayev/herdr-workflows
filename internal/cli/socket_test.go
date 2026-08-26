package cli

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/host"
)

func testCLIEnv(t *testing.T, extra map[string]string) map[string]string {
	t.Helper()
	home := t.TempDir()
	state := t.TempDir()
	plugin := t.TempDir()
	env := map[string]string{
		"HOME":                    home,
		"HERDR_PLUGIN_CONFIG_DIR": plugin,
		"HERDR_PLUGIN_STATE_DIR":  state,
	}
	for key, val := range extra {
		env[key] = val
	}
	return env
}

func listenPingSocket(t *testing.T, protocol int, version string) string {
	t.Helper()
	sockPath := filepath.Join("/tmp", fmt.Sprintf("hwf-cli-%s-%d-%d.sock", t.Name(), os.Getpid(), time.Now().UnixNano()))
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

func listenHerdrRPC(t *testing.T, onRequest func(method string, params map[string]any)) string {
	return listenHerdrRPCReply(t, onRequest, "", "")
}

func listenHerdrRPCReply(t *testing.T, onRequest func(method string, params map[string]any), paneOpenCode, paneOpenMsg string) string {
	t.Helper()
	sockPath := filepath.Join("/tmp", fmt.Sprintf("hwf-cli-rpc-%s-%d-%d.sock", t.Name(), os.Getpid(), time.Now().UnixNano()))
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
				buf := make([]byte, 8192)
				n, _ := c.Read(buf)
				line := string(buf[:n])
				if i := strings.IndexByte(line, '\n'); i >= 0 {
					line = line[:i]
				}
				var req struct {
					ID     string         `json:"id"`
					Method string         `json:"method"`
					Params map[string]any `json:"params"`
				}
				if err := json.Unmarshal([]byte(line), &req); err != nil {
					return
				}
				onRequest(req.Method, req.Params)
				switch req.Method {
				case "ping":
					resp := fmt.Sprintf(`{"id":%q,"result":{"type":"pong","protocol":%d,"version":%q}}`+"\n",
						req.ID, host.Protocol, host.MinHerdrVersion)
					_, _ = c.Write([]byte(resp))
				case "plugin.pane.open":
					if paneOpenMsg != "" {
						resp := fmt.Sprintf(`{"id":%q,"error":{"code":%q,"message":%q}}`+"\n",
							req.ID, paneOpenCode, paneOpenMsg)
						_, _ = c.Write([]byte(resp))
						return
					}
					resp := fmt.Sprintf(`{"id":%q,"result":{"type":"ok"}}`+"\n", req.ID)
					_, _ = c.Write([]byte(resp))
				default:
					resp := fmt.Sprintf(`{"id":%q,"error":{"code":"unexpected","message":%q}}`+"\n", req.ID, req.Method)
					_, _ = c.Write([]byte(resp))
				}
			}(conn)
		}
	}()
	return sockPath
}
