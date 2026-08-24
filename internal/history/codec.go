package history

import (
	"fmt"
	"regexp"
	"strings"
)

type ProgressLine struct {
	Index   int
	Total   int
	Label   string
	Outcome string
}

type Ack struct {
	State string
	ID    string
	Error string
}

var ackRE = regexp.MustCompile(`^@hwf-history:(claimed|unavailable|rejected)(?:\s+(\S+))?(?:\s+(.*))?$`)

func FormatProgressLine(progress ProgressLine) string {
	head := fmt.Sprintf("[%d/%d] %s", progress.Index, progress.Total, progress.Label)
	if progress.Outcome == "start" {
		return head + "…"
	}
	if progress.Outcome == "ok" {
		return head
	}
	return head + " " + progress.Outcome
}

func FormatHistoryAck(ack Ack) string {
	switch ack.State {
	case "claimed":
		return "@hwf-history:claimed " + ack.ID
	case "unavailable":
		if ack.ID != "" {
			return "@hwf-history:unavailable " + ack.ID
		}
		return "@hwf-history:unavailable"
	default:
		if ack.ID != "" {
			return "@hwf-history:rejected " + ack.ID + " " + ack.Error
		}
		return "@hwf-history:rejected " + ack.Error
	}
}

func ParseHistoryAck(line string) *Ack {
	m := ackRE.FindStringSubmatch(strings.TrimSpace(line))
	if m == nil {
		return nil
	}
	state, second, rest := m[1], m[2], m[3]
	switch state {
	case "claimed":
		if second == "" {
			return nil
		}
		return &Ack{State: state, ID: strings.ToLower(second)}
	case "unavailable":
		ack := Ack{State: state}
		if second != "" {
			ack.ID = strings.ToLower(second)
		}
		return &ack
	default:
		if second != "" && rest != "" {
			return &Ack{State: "rejected", ID: strings.ToLower(second), Error: rest}
		}
		err := second
		if err == "" {
			err = rest
		}
		if err == "" {
			err = "launch rejected"
		}
		return &Ack{State: "rejected", Error: err}
	}
}
