package cli

import (
	"fmt"
	"strings"
)

func parseInputs(raw []string) (map[string]string, error) {
	out := map[string]string{}
	for _, item := range raw {
		eq := strings.Index(item, "=")
		if eq <= 0 {
			return nil, fmt.Errorf("--input expects name=value, got '%s'", item)
		}
		out[item[:eq]] = item[eq+1:]
	}
	return out, nil
}
