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

// IsMethodResultDotPath is true if a field is in a success variant of the method result.
func IsMethodResultDotPath(method, field string) bool {
	for _, variant := range methodResultVariants[method] {
		if pathAllowed(variant.Paths, field) {
			return true
		}
	}
	return false
}

// IsGlobalResultDotPath is true if the field is a known native result field.
func IsGlobalResultDotPath(field string) bool {
	return resultDotPaths[field]
}
