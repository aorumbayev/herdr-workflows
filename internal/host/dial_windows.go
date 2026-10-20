//go:build windows

package host

import (
	"net"
	"strings"
	"time"

	"github.com/Microsoft/go-winio"
)

// herdrEndpoint maps HERDR_SOCKET_PATH to the address dialHerdr connects to.
// herdr on Windows listens on a named pipe whose name is the HERDR_SOCKET_PATH
// value verbatim, under the \\.\pipe\ namespace. That is what herdr's own
// plugin helpers connect to (see herdr-agent-state: `\\.\pipe\${socketPath}`),
// so a plain `net.Dial("unix", …)` cannot reach it.
func herdrEndpoint(address string) string {
	if strings.HasPrefix(address, `\\.\pipe\`) {
		return address
	}
	return `\\.\pipe\` + address
}

// dialHerdr opens the herdr control pipe. If no pipe answers, it retries the
// address as a Winsock AF_UNIX socket so that a caller pointing
// HERDR_SOCKET_PATH at a real unix socket keeps working.
func dialHerdr(address string, timeout time.Duration) (net.Conn, error) {
	conn, pipeErr := winio.DialPipe(herdrEndpoint(address), &timeout)
	if pipeErr == nil {
		return conn, nil
	}
	conn, unixErr := net.DialTimeout("unix", address, timeout)
	if unixErr == nil {
		return conn, nil
	}
	return nil, pipeErr
}
