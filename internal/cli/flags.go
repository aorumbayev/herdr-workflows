package cli

import (
	"fmt"
	"strconv"
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

func parsePort(raw string) (int, error) {
	port, err := strconv.Atoi(raw)
	if err != nil || port < 1 || port > 65535 {
		return 0, fmt.Errorf("--port expects an integer between 1 and 65535, got '%s'", raw)
	}
	return port, nil
}
