package console

import (
	"os"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/history"
	"github.com/aorumbayev/herdr-workflows/internal/host"
	"github.com/aorumbayev/herdr-workflows/internal/runsbrowser"
	"github.com/aorumbayev/herdr-workflows/internal/tui"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

type screen int

const (
	screenWorkflows screen = iota
	screenRuns
	screenDetail
	screenDiagram
)

// Options construct a console model.
type Options struct {
	Entries        []workflow.WorkflowListEntry
	RepoRoot       string
	Width          int
	Height         int
	Env            config.Env
	Config         config.Config
	LoadRuns       func() []history.Summary
	LoadDetail     func(runID string) DetailPayload
	LoadWorkflow   func(workflow.WorkflowListEntry) (*workflow.Definition, error)
	CopyClipboard  func(string) error
	ListAgentPanes func() ([]AgentPaneEntry, error)
	PaneSendText   func(paneID, text string) error
	SpillSendback  func(repoRoot, text string) (string, error)
}

// Model is the full-screen console Bubble Tea model.
type Model struct {
	entries             []workflow.WorkflowListEntry
	repoRoot            string
	width               int
	height              int
	getenv              config.Env
	screen              screen
	wfCursor            int
	wfOffset            int
	runCursor           int
	runOffset           int
	runs                []history.Summary
	loadRuns            func() []history.Summary
	loadDetail          func(runID string) DetailPayload
	loadWorkflow        func(workflow.WorkflowListEntry) (*workflow.Definition, error)
	copyText            func(string) error
	definition          *workflow.Definition
	diagramMode         diagramMode
	diagramSelected     map[string]bool
	diagramNodeCursor   int
	instructionDraft    string
	sendbackInstruction string
	pendingSendText     string
	agentPanes          []AgentPaneEntry
	agentCursor         int
	listAgentPanes      func() ([]AgentPaneEntry, error)
	paneSendText        func(paneID, text string) error
	spillSendback       func(repoRoot, text string) (string, error)
	detail              DetailPayload
	diagram             workflow.Diagram
	diagramTitle        string
	diagramScroll       int
	debugTab            DebugTab
	detailScroll        int
	status              string
	quit                bool
}

// New builds a workflows-first console model.
func New(opts Options) Model {
	width := opts.Width
	if width <= 0 {
		width = 80
	}
	getenv := opts.Env
	if getenv == nil {
		getenv = os.Getenv
	}
	loadRuns := opts.LoadRuns
	if loadRuns == nil {
		repoRoot := opts.RepoRoot
		loadRuns = func() []history.Summary {
			state := runsbrowser.Load(repoRoot, runsbrowser.ScopeCurrent, "", "", getenv)
			return state.Items
		}
	}
	loadDetail := opts.LoadDetail
	if loadDetail == nil {
		loadDetail = func(runID string) DetailPayload {
			return defaultLoadDetail(runID, getenv)
		}
	}
	loadWorkflow := opts.LoadWorkflow
	if loadWorkflow == nil && opts.RepoRoot != "" {
		repoRoot := opts.RepoRoot
		cfg := opts.Config
		loadWorkflow = func(entry workflow.WorkflowListEntry) (*workflow.Definition, error) {
			return workflow.LoadWorkflowEntry(entry, repoRoot, cfg)
		}
	}
	copyFn := opts.CopyClipboard
	if copyFn == nil {
		copyFn = tui.CopyToClipboard
	}
	listAgents := opts.ListAgentPanes
	if listAgents == nil {
		listAgents = func() ([]AgentPaneEntry, error) {
			panes, err := host.ListAgentPanes()
			if err != nil {
				return nil, err
			}
			return agentPaneEntriesFromHost(panes), nil
		}
	}
	paneSend := opts.PaneSendText
	if paneSend == nil {
		paneSend = host.PaneSendText
	}
	spillFn := opts.SpillSendback
	if spillFn == nil {
		spillFn = MaybeSpillSendbackText
	}
	return Model{
		entries:        opts.Entries,
		repoRoot:       opts.RepoRoot,
		width:          width,
		height:         opts.Height,
		getenv:         getenv,
		screen:         screenWorkflows,
		loadRuns:       loadRuns,
		loadDetail:     loadDetail,
		loadWorkflow:   loadWorkflow,
		copyText:       copyFn,
		listAgentPanes: listAgents,
		paneSendText:   paneSend,
		spillSendback:  spillFn,
	}
}

func defaultLoadDetail(runID string, getenv config.Env) DetailPayload {
	presented := history.RunDetail(runID, getenv, time.Time{})
	arts, _ := history.LoadDebugArtifacts(runID, getenv)
	payload := DetailPayload{
		Workflow:  presented.Detail.Workflow,
		Artifacts: arts,
	}
	payload.LogLines = runsbrowser.DetailLines(runsbrowser.DetailView{
		Kind:     presented.Detail.Kind,
		ID:       presented.Detail.ID,
		Workflow: presented.Detail.Workflow,
		Message:  presented.Detail.Message,
		Detail:   presented.Detail,
		Blocks:   presented.Blocks,
	}, 80)
	return payload
}

func (m Model) Init() tea.Cmd { return nil }

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, nil
	case tea.KeyPressMsg:
		return m.handleKey(msg)
	}
	return m, nil
}

func (m Model) handleKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	key := msg.String()
	if key == "ctrl+c" {
		m.quit = true
		return m, tea.Quit
	}
	switch m.screen {
	case screenDetail:
		return m.handleDetailKey(msg)
	case screenRuns:
		return m.handleRunsKey(msg)
	case screenDiagram:
		return m.handleDiagramKey(msg)
	default:
		return m.handleWorkflowsKey(msg)
	}
}

func (m Model) handleWorkflowsKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "tab":
		m.screen = screenRuns
		m.runs = m.loadRuns()
		m.runCursor = 0
		m.runOffset = 0
		m.status = ""
		return m, nil
	case "up":
		if m.wfCursor > 0 {
			m.wfCursor--
			m.clampWorkflowWindow()
		}
		return m, nil
	case "down":
		if m.wfCursor+1 < len(m.entries) {
			m.wfCursor++
			m.clampWorkflowWindow()
		}
		return m, nil
	case "enter":
		return m.openSelectedDiagram()
	case "esc":
		m.quit = true
		return m, tea.Quit
	}
	return m, nil
}

func (m Model) handleRunsKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "tab":
		m.screen = screenWorkflows
		m.status = ""
		return m, nil
	case "up":
		if m.runCursor > 0 {
			m.runCursor--
			m.clampRunWindow()
		}
		return m, nil
	case "down":
		if m.runCursor+1 < len(m.runs) {
			m.runCursor++
			m.clampRunWindow()
		}
		return m, nil
	case "enter":
		if m.runCursor < 0 || m.runCursor >= len(m.runs) {
			return m, nil
		}
		id := m.runs[m.runCursor].ID
		m.detail = m.loadDetail(id)
		m.debugTab = DebugTabLog
		m.detailScroll = 0
		m.screen = screenDetail
		m.status = ""
		return m, nil
	case "esc":
		m.quit = true
		return m, tea.Quit
	}
	return m, nil
}

func (m Model) openSelectedDiagram() (tea.Model, tea.Cmd) {
	if m.wfCursor < 0 || m.wfCursor >= len(m.entries) {
		return m, nil
	}
	entry := m.entries[m.wfCursor]
	if entry.Error != "" {
		m.status = "diagram unavailable" + tui.ChromeSep + entry.Error
		return m, nil
	}
	if m.loadWorkflow == nil {
		m.status = "diagram unavailable" + tui.ChromeSep + "workflow loader not wired"
		return m, nil
	}
	def, err := m.loadWorkflow(entry)
	if err != nil {
		m.status = "diagram unavailable" + tui.ChromeSep + err.Error()
		return m, nil
	}
	title := entry.Title
	if title == "" {
		title = entry.Name
	}
	m.diagram = workflow.ProjectDiagram(*def)
	m.definition = def
	m.diagramTitle = title
	m.diagramScroll = 0
	m.diagramMode = diagramModeView
	m.diagramSelected = nil
	m.diagramNodeCursor = 0
	m.resetDiagramSendback()
	m.screen = screenDiagram
	m.status = ""
	return m, nil
}

func (m Model) handleDetailKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	key := msg.String()
	switch key {
	case "esc":
		m.screen = screenRuns
		m.status = ""
		return m, nil
	case "1":
		m.debugTab = DebugTabLog
		m.detailScroll = 0
		return m, nil
	case "2":
		m.debugTab = DebugTabTranscript
		m.detailScroll = 0
		return m, nil
	case "3":
		m.debugTab = DebugTabYAML
		m.detailScroll = 0
		return m, nil
	case "y":
		name := m.detail.Workflow
		if name == "" && m.runCursor >= 0 && m.runCursor < len(m.runs) {
			name = m.runs[m.runCursor].Workflow
		}
		cmd := FormatRetryCommand(name)
		if err := m.copyText(cmd); err != nil {
			m.status = "retry copy failed" + tui.ChromeSep + err.Error()
			return m, nil
		}
		m.status = "copied" + tui.ChromeSep + cmd
		return m, nil
	case "up":
		if m.detailScroll > 0 {
			m.detailScroll--
		}
		return m, nil
	case "down":
		m.detailScroll++
		return m, nil
	}
	return m, nil
}

func (m *Model) listViewport() int {
	h := m.height - 4
	if h < 3 {
		return 3
	}
	if h > 20 {
		return 20
	}
	return h
}

func (m *Model) clampWorkflowWindow() {
	vp := m.listViewport()
	if m.wfCursor < m.wfOffset {
		m.wfOffset = m.wfCursor
	}
	if m.wfCursor >= m.wfOffset+vp {
		m.wfOffset = m.wfCursor - vp + 1
	}
}

func (m *Model) clampRunWindow() {
	vp := m.listViewport()
	if m.runCursor < m.runOffset {
		m.runOffset = m.runCursor
	}
	if m.runCursor >= m.runOffset+vp {
		m.runOffset = m.runCursor - vp + 1
	}
}

func (m Model) contentWidth() int {
	return tui.ContentWidth(m.width)
}

func debugContentOf(d DetailPayload) DebugContent {
	return DebugContent{
		LogLines:   d.LogLines,
		EntryYAML:  d.Artifacts.EntryYAML,
		Transcript: d.Artifacts.Transcript,
	}
}

func asciiLines(text string, width int) []string {
	if text == "" {
		return nil
	}
	raw := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	out := make([]string, 0, len(raw))
	for _, line := range raw {
		out = append(out, tui.Truncate(line, width))
	}
	return out
}
