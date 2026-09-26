package cli

import (
	"fmt"
	"strings"
)

func parseInputs(raw []string) (map[string]string, error) {
	out := map[string]string{}
	for i, item := range raw {
		eq := strings.Index(item, "=")
		if eq <= 0 {
			return nil, fmt.Errorf("--input expects name=value (item %d)", i+1)
		}
		out[item[:eq]] = item[eq+1:]
	}
	return out, nil
}
