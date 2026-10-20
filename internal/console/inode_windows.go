//go:build windows

package console

import (
	"os"
	"syscall"
)

// fileInode reports a change token for the file behind path. Windows has no
// inode in os.FileInfo, and an atomic save (rename over the target) can keep
// both mtime and size, so the volume serial number and file index from the
// directory entry stand in for the inode: a rename onto the path yields a new
// file index, which is what change detection needs to see.
func fileInode(path string, _ os.FileInfo) uint64 {
	ptr, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return 0
	}
	handle, err := syscall.CreateFile(
		ptr,
		0x80, // FILE_READ_ATTRIBUTES
		syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE,
		nil,
		syscall.OPEN_EXISTING,
		syscall.FILE_ATTRIBUTE_NORMAL,
		0,
	)
	if err != nil {
		return 0
	}
	defer func() { _ = syscall.CloseHandle(handle) }()

	var info syscall.ByHandleFileInformation
	if err := syscall.GetFileInformationByHandle(handle, &info); err != nil {
		return 0
	}
	return uint64(info.VolumeSerialNumber)<<32 ^ uint64(info.FileIndexHigh)<<16 ^ uint64(info.FileIndexLow)
}
