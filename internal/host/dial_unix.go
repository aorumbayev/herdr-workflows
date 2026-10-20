//go:build !windows

package host

import (
	"net"
	"time"
)

// herdrEndpoint maps HERDR_SOCKET_PATH to the address dialHerdr connects to.
// On Unix the path herdr exports is already the socket path.
func herdrEndpoint(address string) string {
	return address
}

func dialHerdr(address string, timeout time.Duration) (net.Conn, error) {
	return net.DialTimeout("unix", herdrEndpoint(address), timeout)
}
