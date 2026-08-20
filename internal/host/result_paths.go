package host

import "strings"

func pathAllowed(paths []string, field string) bool {
	for _, path := range paths {
		if path == field || strings.HasPrefix(path, field+".") {
			return true
		}
	}
	return false
}

// IsMethodResultDotPath reports whether a field is present in a success
// variant of the method result.
func IsMethodResultDotPath(method, field string) bool {
	for _, variant := range methodResultVariants[method] {
		if pathAllowed(variant.Paths, field) {
			return true
		}
	}
	return false
}

// IsGlobalResultDotPath reports whether a native result field is known.
func IsGlobalResultDotPath(field string) bool {
	return resultDotPaths[field]
}
