package console

import (
	"strings"

	"github.com/aorumbayev/herdr-workflows/internal/history"
	"github.com/aorumbayev/herdr-workflows/internal/tui"
)

// DebugTab is one run-detail debug pane.
type DebugTab int

const (
	DebugTabLog DebugTab = iota
	DebugTabTranscript
	DebugTabYAML
)

// DebugContent feeds FormatDebugBody.
type DebugContent struct {
	LogLines   []string
	EntryYAML  string
	Transcript string
}

// FormatRetryCommand is the clipboard payload for retry-copy.
func FormatRetryCommand(workflow string) string {
	return "hwf run " + strings.TrimSpace(workflow)
}

// FormatDebugBody renders one debug tab's body text.
func FormatDebugBody(tab DebugTab, content DebugContent) string {
	switch tab {
	case DebugTabTranscript:
		if strings.TrimSpace(content.Transcript) == "" {
			return "no transcript captured for this run"
		}
		return content.Transcript
	case DebugTabYAML:
		if strings.TrimSpace(content.EntryYAML) == "" {
			return "no yaml-at-run captured for this run"
		}
		return content.EntryYAML
	default:
		if len(content.LogLines) == 0 {
			return "no log lines for this run"
		}
		return strings.Join(content.LogLines, "\n")
	}
}

// FormatDebugTabChrome labels the three debug tabs with the active marker.
func FormatDebugTabChrome(active DebugTab) string {
	labels := []string{"1 log", "2 transcript", "3 yaml"}
	for i := range labels {
		if DebugTab(i) == active {
			labels[i] = ">" + labels[i]
		} else {
			labels[i] = " " + labels[i]
		}
	}
	return strings.Join(labels, tui.ChromeSep)
}

// DetailPayload is one run's console detail load.
type DetailPayload struct {
	Workflow  string
	LogLines  []string
	Artifacts history.DebugArtifacts
}
