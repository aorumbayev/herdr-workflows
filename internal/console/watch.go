package console

import (
	"os"
	"syscall"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/tui"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

// watchTickMsg carries the epoch of the diagram that armed it, so a tick left
// over from an earlier diagram dies instead of doubling the poll rate.
type watchTickMsg struct{ epoch int }

func watchTick(epoch int) tea.Cmd {
	return tea.Tick(400*time.Millisecond, func(time.Time) tea.Msg {
		return watchTickMsg{epoch: epoch}
	})
}

type diagramFileStamp struct {
	nano int64
	size int64
	ino  uint64
}

func fileStamp(path string) (diagramFileStamp, bool) {
	if path == "" {
		return diagramFileStamp{}, false
	}
	info, err := os.Stat(path)
	if err != nil {
		return diagramFileStamp{}, false
	}
	var ino uint64
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		ino = st.Ino
	}
	return diagramFileStamp{nano: info.ModTime().UnixNano(), size: info.Size(), ino: ino}, true
}

func loadDiagramYAML(path string) []string {
	if path == "" {
		return nil
	}
	body, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	return tui.SplitStepYAML(string(body))
}

func (m Model) handleWatchTick(epoch int) (tea.Model, tea.Cmd) {
	if epoch != m.watchEpoch || m.screen != screenDiagram || m.diagramFile == "" {
		return m, nil
	}
	stamp, ok := fileStamp(m.diagramFile)
	if !ok {
		m.status = "watch failed" + tui.ChromeSep + "cannot read " + m.diagramFile
		return m, watchTick(epoch)
	}
	if stamp == m.diagramStamp {
		return m, watchTick(epoch)
	}
	m.diagramStamp = stamp
	body, err := os.ReadFile(m.diagramFile)
	if err != nil {
		m.status = "watch failed" + tui.ChromeSep + err.Error()
		return m, watchTick(epoch)
	}
	name := ""
	if m.definition != nil {
		name = m.definition.Name
	}
	def, err := workflow.ParseWorkflowText(name, string(body), m.cfg, m.repoRoot, m.diagramFile)
	if err != nil {
		m.status = err.Error()
		return m, watchTick(epoch)
	}
	prev := m.diagram
	prevSel := m.diagramSelected
	prevFocus := m.diagramFocus
	m.diagram = workflow.ProjectDiagram(*def)
	m.definition = def
	m.diagramYAML = tui.SplitStepYAML(string(body))
	m.diagramSelected = reselectIDs(prevSel, m.diagram)
	m.diagramFocus = reresolveFocus(prevFocus, prev, m.diagram)
	m.clampYAMLScroll()
	m.status = ""
	return m, watchTick(epoch)
}

func reselectIDs(prev map[string]bool, d workflow.Diagram) map[string]bool {
	if len(prev) == 0 {
		return nil
	}
	present := map[string]bool{}
	for _, node := range d.Nodes {
		if node.ID != "" {
			present[node.ID] = true
		}
	}
	out := map[string]bool{}
	for id, on := range prev {
		if on && present[id] {
			out[id] = true
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func nodeIDAt(d workflow.Diagram, i int) string {
	if i < 0 || i >= len(d.Nodes) {
		return ""
	}
	return d.Nodes[i].ID
}

// reresolveFocus keeps the focus on the same declared step across a reload. A
// positional focus has no stable name, so it returns to the first card.
func reresolveFocus(focus railFocus, prev, next workflow.Diagram) railFocus {
	id := nodeIDAt(prev, focus.Index)
	if id == "" {
		return railFocus{}
	}
	for i, node := range next.Nodes {
		if node.ID == id {
			return railFocus{Index: i}
		}
	}
	return railFocus{}
}
