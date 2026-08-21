package host

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/caps"
)

// rpcTimeout is a var so the timeout path is testable without a 10 s wait.
var rpcTimeout = 10 * time.Second

// HerdrResponse is a single JSON-RPC-style reply from the herdr socket.
type HerdrResponse struct {
	ID     string         `json:"id"`
	Result map[string]any `json:"result"`
	Error  *rpcError      `json:"error"`
}

type rpcError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func socketPath() (string, error) {
	path := strings.TrimSpace(os.Getenv("HERDR_SOCKET_PATH"))
	if path == "" {
		return "", &HerdrError{Code: "no_socket", Msg: "HERDR_SOCKET_PATH is not set"}
	}
	return path, nil
}

func unreachableFailure(method, address, reason string) error {
	return &HerdrError{Code: "unreachable", Msg: fmt.Sprintf("unreachable herdr at %s: %s: %s", address, method, reason)}
}

func closedFailure(method string) error {
	return &HerdrError{Code: "closed", Msg: fmt.Sprintf("%s: socket closed before response", method)}
}

func asHerdrError(err error, code, fallback string) error {
	var herdr *HerdrError
	if errors.As(err, &herdr) {
		return herdr
	}
	msg := fallback
	if err != nil && err.Error() != "" {
		msg = err.Error()
	}
	return &HerdrError{Code: code, Msg: msg}
}

func randomHex(n int) string {
	b := make([]byte, (n+1)/2)
	if _, err := rand.Read(b); err != nil {
		return strings.Repeat("0", n)
	}
	return hex.EncodeToString(b)[:n]
}

// HerdrRequest performs a raw socket request to the connected herdr. Prefer the
// CLI wrappers when they exist. The method layout.apply has no CLI surface. The
// picker calls plugin.pane.open on a hot path, where a CLI subprocess costs
// about 50 ms per launch.
func HerdrRequest(method string, params map[string]any) (HerdrResponse, error) {
	address, err := socketPath()
	if err != nil {
		return HerdrResponse{}, err
	}
	id := "herdr-workflows:" + randomHex(8)
	payload, err := json.Marshal(struct {
		ID     string         `json:"id"`
		Method string         `json:"method"`
		Params map[string]any `json:"params"`
	}{id, method, params})
	if err != nil {
		return HerdrResponse{}, err
	}
	payload = append(payload, '\n')

	deadline := time.Now().Add(rpcTimeout)
	conn, err := net.DialTimeout("unix", address, rpcTimeout)
	if err != nil {
		return HerdrResponse{}, unreachableFailure(method, address, err.Error())
	}
	defer func() { _ = conn.Close() }()
	_ = conn.SetDeadline(deadline)

	if _, err := conn.Write(payload); err != nil {
		return HerdrResponse{}, unreachableFailure(method, address, err.Error())
	}

	var buf []byte
	chunk := make([]byte, 4096)
	for {
		n, err := conn.Read(chunk)
		if n == 0 {
			if errors.Is(err, io.EOF) {
				return HerdrResponse{}, closedFailure(method)
			}
			var netErr net.Error
			if errors.As(err, &netErr) && netErr.Timeout() {
				return HerdrResponse{}, unreachableFailure(method, address, fmt.Sprintf("timed out after %dms", rpcTimeout.Milliseconds()))
			}
			return HerdrResponse{}, unreachableFailure(method, address, err.Error())
		}
		buf = append(buf, chunk[:n]...)
		if len(buf) > caps.CaptureByteLimit {
			return HerdrResponse{}, &caps.CaptureLimitError{Source: "herdr result", Bytes: len(buf), Limit: caps.CaptureByteLimit}
		}
		if i := bytes.IndexByte(buf, '\n'); i >= 0 {
			var resp HerdrResponse
			if err := json.Unmarshal(buf[:i], &resp); err != nil {
				return HerdrResponse{}, &HerdrError{Code: "invalid_response", Msg: fmt.Sprintf("invalid JSON from herdr for %s", method)}
			}
			return resp, nil
		}
	}
}

// HerdrCall performs a socket request and unwraps the result, mapping a
// response error to a typed HerdrError.
func HerdrCall(method string, params map[string]any) (map[string]any, error) {
	resp, err := HerdrRequest(method, params)
	if err != nil {
		return nil, asHerdrError(err, "internal", fmt.Sprintf("herdr call failed: %s", method))
	}
	if resp.Error != nil {
		return nil, &HerdrError{Code: resp.Error.Code, Msg: resp.Error.Message}
	}
	if resp.Result == nil {
		return nil, &HerdrError{Code: "empty_result", Msg: fmt.Sprintf("no result for %s", method)}
	}
	return resp.Result, nil
}
