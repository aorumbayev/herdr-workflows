package host

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/caps"
)

// listen binds a unix socket and gives each connection to serve. The maximum
// length of a unix socket path on macOS is 104 bytes, so the test binds in /tmp.
// Paths from t.TempDir() are often too long.
func listen(t *testing.T, name string, serve func(net.Conn)) string {
	t.Helper()
	sockPath := filepath.Join("/tmp", fmt.Sprintf("hwf-rpc-%s-%d-%d.sock", name, os.Getpid(), time.Now().UnixNano()))
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
			serve(conn)
			// Read remaining request bytes so that a close does not break the pipe during a write.
			_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
			_, _ = io.Copy(io.Discard, conn)
			_ = conn.Close()
		}
	}()
	t.Setenv("HERDR_SOCKET_PATH", sockPath)
	return sockPath
}

func readRequest(t *testing.T, conn net.Conn) map[string]any {
	t.Helper()
	buf := make([]byte, 4096)
	n, _ := conn.Read(buf)
	var req map[string]any
	if err := json.Unmarshal(buf[:n], &req); err != nil {
		t.Errorf("bad request JSON: %v", err)
	}
	return req
}

// wantHerdrCode makes sure that the error code is correct and gives the message for more checks.
func wantHerdrCode(t *testing.T, err error, code string) string {
	t.Helper()
	if err == nil {
		t.Fatalf("expected error with code %q", code)
	}
	var herdr *HerdrError
	if !errors.As(err, &herdr) {
		t.Fatalf("expected HerdrError, got %T (%v)", err, err)
	}
	if herdr.Code != code {
		t.Fatalf("got code %q, want %q: %s", herdr.Code, code, herdr.Msg)
	}
	return herdr.Msg
}

func TestHerdrRequestClosedBeforeResponse(t *testing.T) {
	accepted := make(chan struct{}, 1)
	listen(t, "closed", func(net.Conn) { accepted <- struct{}{} })

	_, err := HerdrRequest("layout.apply", map[string]any{})
	msg := wantHerdrCode(t, err, "closed")
	if !strings.Contains(msg, "layout.apply: socket closed before response") {
		t.Fatalf("got %q, want closed message naming the method", msg)
	}
	if !IsTransportLoss(err) {
		t.Fatalf("closed should be transport loss, got %v", err)
	}
	<-accepted
}

func TestHerdrRequestRoundTrip(t *testing.T) {
	listen(t, "ok", func(conn net.Conn) {
		req := readRequest(t, conn)
		_, _ = conn.Write([]byte(`{"id":"x","result":{"method":` + jsonEscape(fmt.Sprint(req["method"])) + `}}` + "\n"))
	})

	resp, err := HerdrRequest("ping", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if resp.Result["method"] != "ping" {
		t.Fatalf("got result %v", resp.Result)
	}
}

func TestHerdrRequestNoSocket(t *testing.T) {
	t.Setenv("HERDR_SOCKET_PATH", "")
	_, err := HerdrRequest("ping", map[string]any{})
	wantHerdrCode(t, err, "no_socket")
	if !IsTransportLoss(err) {
		t.Fatal("no_socket should be transport loss")
	}
}

func TestHerdrRequestTimesOut(t *testing.T) {
	previous := rpcTimeout
	rpcTimeout = 50 * time.Millisecond
	t.Cleanup(func() { rpcTimeout = previous })

	done := make(chan struct{})
	listen(t, "slow", func(net.Conn) { <-done })
	t.Cleanup(func() { close(done) })

	_, err := HerdrRequest("ping", map[string]any{})
	msg := wantHerdrCode(t, err, "unreachable")
	if !strings.Contains(msg, "timed out after 50ms") {
		t.Fatalf("got %q, want the timeout budget", msg)
	}
}

func TestHerdrRequestCaptureCap(t *testing.T) {
	listen(t, "flood", func(conn net.Conn) {
		chunk := make([]byte, 64*1024)
		for i := range chunk {
			chunk[i] = 'x'
		}
		for written := 0; written <= caps.CaptureByteLimit; written += len(chunk) {
			if _, err := conn.Write(chunk); err != nil {
				return
			}
		}
	})

	_, err := HerdrRequest("ping", map[string]any{})
	var capErr *caps.CaptureLimitError
	if !errors.As(err, &capErr) {
		t.Fatalf("got %v, want CaptureLimitError", err)
	}
	if capErr.Source != "herdr result" || capErr.Limit != caps.CaptureByteLimit {
		t.Fatalf("got %+v", capErr)
	}
}

func TestHerdrRequestInvalidResponse(t *testing.T) {
	listen(t, "garbage", func(conn net.Conn) {
		_, _ = conn.Write([]byte("not json\n"))
	})

	_, err := HerdrRequest("pane.split", map[string]any{})
	msg := wantHerdrCode(t, err, "invalid_response")
	if !strings.Contains(msg, "pane.split") {
		t.Fatalf("got %q, want the method named", msg)
	}
	if IsTransportLoss(err) {
		t.Fatal("invalid_response is not transport loss")
	}
}

func TestHerdrCallEmptyResult(t *testing.T) {
	listen(t, "empty", func(conn net.Conn) {
		_, _ = conn.Write([]byte(`{"id":"x"}` + "\n"))
	})

	_, err := HerdrCall("ping", map[string]any{})
	msg := wantHerdrCode(t, err, "empty_result")
	if !strings.Contains(msg, "no result for ping") {
		t.Fatalf("got %q", msg)
	}
}

func TestHerdrCallResponseError(t *testing.T) {
	listen(t, "err", func(conn net.Conn) {
		_, _ = conn.Write([]byte(`{"id":"x","error":{"code":"not_found","message":"no such pane"}}` + "\n"))
	})

	_, err := HerdrCall("pane.close", map[string]any{"pane_id": "w1:p1"})
	msg := wantHerdrCode(t, err, "not_found")
	if msg != "no such pane" {
		t.Fatalf("got %q", msg)
	}
}

func TestHerdrCallKeepsTransportLossCode(t *testing.T) {
	accepted := make(chan struct{}, 1)
	listen(t, "call-closed", func(net.Conn) { accepted <- struct{}{} })

	_, err := HerdrCall("layout.apply", map[string]any{})
	wantHerdrCode(t, err, "closed")
	if !IsTransportLoss(err) {
		t.Fatal("HerdrCall must not rewrap a transport-loss code as internal")
	}
	<-accepted
}

func TestEnsureHerdrProtocol(t *testing.T) {
	t.Run("no socket is a no-op", func(t *testing.T) {
		t.Setenv("HERDR_SOCKET_PATH", "")
		resetProtocolChecked(t)
		if err := EnsureHerdrProtocol(); err != nil {
			t.Fatalf("expected a no-op, got %v", err)
		}
	})

	t.Run("mismatch fails", func(t *testing.T) {
		resetProtocolChecked(t)
		listen(t, "proto-bad", func(conn net.Conn) {
			readRequest(t, conn)
			_, _ = conn.Write([]byte(fmt.Sprintf(`{"id":"x","result":{"protocol":%d,"version":%q}}`, Protocol+1, MinHerdrVersion) + "\n"))
		})
		err := EnsureHerdrProtocol()
		msg := wantHerdrCode(t, err, "protocol_mismatch")
		if !strings.Contains(msg, "herdr protocol mismatch") {
			t.Fatalf("got %q", msg)
		}
	})

	t.Run("match checks once", func(t *testing.T) {
		resetProtocolChecked(t)
		pings := make(chan struct{}, 4)
		listen(t, "proto-ok", func(conn net.Conn) {
			readRequest(t, conn)
			pings <- struct{}{}
			_, _ = conn.Write([]byte(fmt.Sprintf(`{"id":"x","result":{"protocol":%d,"version":%q}}`, Protocol, MinHerdrVersion) + "\n"))
		})
		for range 2 {
			if err := EnsureHerdrProtocol(); err != nil {
				t.Fatal(err)
			}
		}
		if len(pings) != 1 {
			t.Fatalf("pinged %d times, want one one-shot check", len(pings))
		}
	})
}

func resetProtocolChecked(t *testing.T) {
	t.Helper()
	protocolCheckedMu.Lock()
	protocolChecked = false
	protocolCheckedMu.Unlock()
	t.Cleanup(func() {
		protocolCheckedMu.Lock()
		protocolChecked = false
		protocolCheckedMu.Unlock()
	})
}

func jsonEscape(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func TestNotificationShowSpawnFailure(t *testing.T) {
	t.Setenv("HERDR_BIN_PATH", "/nonexistent/herdr-bin-xyz")
	err := NotificationShow("title")
	msg := wantHerdrCode(t, err, "internal")
	if IsTransportLoss(err) {
		t.Fatal("internal should not be transport loss")
	}
	if !strings.Contains(msg, "/nonexistent/herdr-bin-xyz") {
		t.Fatalf("message %q should name the binary", msg)
	}
}
