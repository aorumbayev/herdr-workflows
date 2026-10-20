//go:build !windows

package console

import (
	"os"
	"syscall"
)

func fileInode(_ string, info os.FileInfo) uint64 {
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		return st.Ino
	}
	return 0
}
