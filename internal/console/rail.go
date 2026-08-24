package console

import (
	"fmt"
	"strings"

	"github.com/aorumbayev/herdr-workflows/internal/runsbrowser"
	"github.com/aorumbayev/herdr-workflows/internal/tui"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

type railHit struct {
	Index int
	Step  string
	Y0    int
	Y1    int
	X0    int
	X1    int
}

type railFocus struct {
	Index int
}

func cardSlot(index int) int { return index * 2 }

func maxRailScroll(n int) int { return max(0, cardSlot(n-1)) }

func moveRailFocus(f railFocus, n, delta int) railFocus {
	if n <= 0 {
		return railFocus{}
	}
	return railFocus{Index: min(max(f.Index+delta, 0), n-1)}
}

func railTitle(node workflow.DiagramNode) (title string, derived bool) {
	if node.ID != "" {
		return node.ID, false
	}
	if node.Label != "" {
		return node.Label, true
	}
	return fmt.Sprintf("step %d", node.Index), false
}

type DiagramMarks struct {
	Focus      railFocus
	Selected   map[string]bool
	YAMLScroll int
}

func diagramCards(d workflow.Diagram, marks DiagramMarks) []tui.CardSpec {
	cards := make([]tui.CardSpec, 0, len(d.Nodes))
	theme := tui.DefaultTheme()
	for i, node := range d.Nodes {
		kind := node.Kind
		if kind == "" {
			kind = "step"
		}
		title, derived := railTitle(node)
		if derived {
			title += theme.Muted.Render(fmt.Sprintf(" ·%d", node.Index))
		}
		var body []string
		for _, clause := range node.When {
			body = append(body, "when: "+formatDiagramWhen(clause))
		}
		if node.Placement != nil {
			if p := formatDiagramPlacement(node.Placement); p != "" {
				body = append(body, p)
			}
		}
		selected := marks.Selected != nil && node.ID != "" && marks.Selected[node.ID]
		cards = append(cards, tui.CardSpec{
			Kind:     kind,
			Title:    title,
			Body:     body,
			Focused:  marks.Focus.Index == i,
			Selected: selected,
			Muted:    node.ID == "",
		})
	}
	return cards
}

func renderRailYAML(d workflow.Diagram, chunks []string, marks DiagramMarks, width, height, scroll int) (string, []railHit) {
	leftW, rightW := tui.RailSplit(width)
	rail, hits := tui.RenderRail(diagramCards(d, marks), leftW, height, scroll)
	yaml := renderYAMLPane(d, chunks, marks, rightW, height)
	mapped := make([]railHit, len(hits))
	for i, h := range hits {
		step := ""
		if h.Index >= 0 && h.Index < len(d.Nodes) {
			step = d.Nodes[h.Index].ID
		}
		mapped[i] = railHit{Index: h.Index, Step: step, Y0: h.Y0, Y1: h.Y1, X0: 0, X1: leftW}
	}
	return tui.JoinRail(rail, yaml, leftW, height), mapped
}

func railScrollIntoView(d workflow.Diagram, marks DiagramMarks, width, height, scroll int) int {
	leftW, _ := tui.RailSplit(width)
	return tui.RailScrollIntoView(diagramCards(d, marks), marks.Focus.Index, leftW, height, scroll)
}

func renderYAMLPane(d workflow.Diagram, chunks []string, marks DiagramMarks, rightW, height int) string {
	lines := railYAMLLines(d, chunks, marks.Focus, rightW)
	if height <= 0 {
		return strings.Join(lines, "\n")
	}
	visible, _ := runsbrowser.ScrollDetailLines(lines, marks.YAMLScroll, height)
	return strings.Join(visible, "\n")
}

func railYAMLLines(d workflow.Diagram, chunks []string, focus railFocus, rightW int) []string {
	theme := tui.DefaultTheme()
	if focus.Index < 0 || focus.Index >= len(d.Nodes) {
		return []string{theme.Muted.Render("(no step)")}
	}
	if len(chunks) != len(d.Nodes) {
		return []string{theme.Muted.Render(tui.Truncate("(step source unavailable)", rightW))}
	}
	lines := strings.Split(tui.ColorYAML(chunks[focus.Index]), "\n")
	for i, line := range lines {
		lines[i] = tui.Truncate(line, rightW)
	}
	return lines
}

func hitAt(hits []railHit, x, y int) (railHit, bool) {
	for _, h := range hits {
		if y >= h.Y0 && y < h.Y1 && x >= h.X0 && x < h.X1 {
			return h, true
		}
	}
	return railHit{}, false
}
