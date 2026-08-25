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
	listListChrome   = 7 // head, spacer, list, spacer, detail(2), rule, footer
	scrollViewChrome = 3 // head, scroll body, rule, footer

	screenWorkflows screen = iota
	screenRuns
	screenDetail
	screenDiagram
)

// Options is the input for a console model.
type Options struct {
	Entries         []workflow.ListEntry
	RepoRoot        string
	Width           int
	Height          int
	Env             config.Env
	Config          config.Config
	LoadRuns        func() []history.Summary
	LoadDetail      func(runID string) DetailPayload
	LoadWorkflow    func(workflow.ListEntry) (*workflow.Definition, error)
	CopyClipboard   func(string) error
	LandingWorkflow string
	ListAgentPanes  func() ([]AgentPaneEntry, error)
	PaneSendText    func(paneID, text string) error
	SpillSendback   func(repoRoot, text string) (string, string, error)
	Now             func() time.Time
}

// Model is the full-screen console Bubble Tea model.
type Model struct {
	entries             []workflow.ListEntry
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
	loadWorkflow        func(workflow.ListEntry) (*workflow.Definition, error)
	copyText            func(string) error
	definition          *workflow.Definition
	diagramMode         diagramMode
	diagramSelected     map[string]bool
	insertAt            insertSide
	instructionDraft    string
	sendbackInstruction string
	pendingSendText     string
	agentPanes          []AgentPaneEntry
	agentCursor         int
	agentOffset         int
	pendingSpillPath    string
	listAgentPanes      func() ([]AgentPaneEntry, error)
	paneSendText        func(paneID, text string) error
	spillSendback       func(repoRoot, text string) (string, string, error)
	wfFilter            string
	runFilter           string
	initCmd             tea.Cmd
	cfg                 config.Config
	detail              DetailPayload
	diagram             workflow.Diagram
	diagramTitle        string
	diagramFile         string
	diagramYAML         []string
	diagramStamp        diagramFileStamp
	diagramFocus        railFocus
	diagramScroll       int
	diagramYAMLScroll   int
	watchEpoch          int
	runsEpoch           int
	runsTicking         bool
	now                 func() time.Time
	debugTab            DebugTab
	detailScroll        int
	status              string
	quit                bool
}

// New makes a workflows-first console model.
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
		loadWorkflow = func(entry workflow.ListEntry) (*workflow.Definition, error) {
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
			return AgentPaneEntriesFromHost(panes), nil
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
	nowFn := opts.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	m := Model{
		entries:        opts.Entries,
		repoRoot:       opts.RepoRoot,
		width:          width,
		height:         opts.Height,
		getenv:         getenv,
		now:            nowFn,
		screen:         screenWorkflows,
		loadRuns:       loadRuns,
		loadDetail:     loadDetail,
		loadWorkflow:   loadWorkflow,
		copyText:       copyFn,
		listAgentPanes: listAgents,
		paneSendText:   paneSend,
		spillSendback:  spillFn,
		cfg:            opts.Config,
	}
	if opts.LandingWorkflow != "" {
		for _, e := range opts.Entries {
			if e.Name == opts.LandingWorkflow {
				opened, cmd := m.OpenDiagram(e)
				m, m.initCmd = opened, cmd
				break
			}
		}
	}
	return m
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

func (m Model) Init() tea.Cmd { return m.initCmd }

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, nil
	case tea.KeyPressMsg:
		return m.handleKey(msg)
	case tea.MouseClickMsg, tea.MouseWheelMsg:
		return m.handleMouse(msg)
	case watchTickMsg:
		return m.handleWatchTick(msg.epoch)
	case runsTickMsg:
		return m.handleRunsTick(msg.epoch)
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
		return m.armRunsTick()
	case "up":
		if m.wfCursor > 0 {
			m.wfCursor--
			m.clampWorkflowWindow()
		}
		return m, nil
	case "down":
		if m.wfCursor+1 < len(m.visibleEntries()) {
			m.wfCursor++
			m.clampWorkflowWindow()
		}
		return m, nil
	case "enter":
		return m.openSelectedDiagram()
	case "esc":
		m.quit = true
		return m, tea.Quit
	case "backspace":
		if m.wfFilter != "" {
			r := []rune(m.wfFilter)
			m.wfFilter = string(r[:len(r)-1])
			m.wfCursor, m.wfOffset = 0, 0
		}
		return m, nil
	default:
		if msg.Mod == 0 && msg.Text != "" {
			m.wfFilter += msg.Text
			m.wfCursor, m.wfOffset = 0, 0
		}
		return m, nil
	}
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
		if m.runCursor+1 < len(m.visibleRuns()) {
			m.runCursor++
			m.clampRunWindow()
		}
		return m, nil
	case "enter":
		runs := m.visibleRuns()
		if m.runCursor < 0 || m.runCursor >= len(runs) {
			return m, nil
		}
		m.detail = m.loadDetail(runs[m.runCursor].ID)
		m.debugTab = DebugTabLog
		m.detailScroll = 0
		m.screen = screenDetail
		m.status = ""
		return m, nil
	case "esc":
		m.quit = true
		return m, tea.Quit
	case "backspace":
		if m.runFilter != "" {
			r := []rune(m.runFilter)
			m.runFilter = string(r[:len(r)-1])
			m.runCursor, m.runOffset = 0, 0
		}
		return m, nil
	default:
		if msg.Mod == 0 && msg.Text != "" {
			m.runFilter += msg.Text
			m.runCursor, m.runOffset = 0, 0
		}
		return m, nil
	}
}

func (m Model) openSelectedDiagram() (tea.Model, tea.Cmd) {
	entries := m.visibleEntries()
	if m.wfCursor < 0 || m.wfCursor >= len(entries) {
		return m, nil
	}
	entry := entries[m.wfCursor]
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
	m.diagramFile = entry.File
	m.diagramYAML = loadDiagramYAML(entry.File)
	m.diagramStamp, _ = fileStamp(entry.File)
	m.diagramScroll = 0
	m.diagramYAMLScroll = 0
	m.diagramMode = diagramModeView
	m.diagramSelected = nil
	m.insertAt = ""
	m.diagramFocus = railFocus{}
	m.watchEpoch++
	m.resetDiagramSendback()
	m.screen = screenDiagram
	m.status = ""
	if m.diagramFile == "" {
		return m, nil
	}
	return m, watchTick(m.watchEpoch)
}

// OpenDiagram opens one workflow diagram with no console list. The picker tab
// is already a workflow list, so it opens the diagram directly.
func (m Model) OpenDiagram(entry workflow.ListEntry) (Model, tea.Cmd) {
	for i, e := range m.visibleEntries() {
		if e.Name == entry.Name && e.File == entry.File {
			m.wfCursor = i
			m.clampWorkflowWindow()
			break
		}
	}
	next, cmd := m.openSelectedDiagram()
	return next.(Model), cmd
}

func (m Model) handleDetailKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	key := msg.String()
	switch key {
	case "esc":
		m.screen = screenRuns
		m.status = ""
		return m.armRunsTick()
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
		if runs := m.visibleRuns(); name == "" && m.runCursor >= 0 && m.runCursor < len(runs) {
			name = runs[m.runCursor].Workflow
		}
		cmd := FormatRetryCommand(name)
		if err := m.copyText(cmd); err != nil {
			m.status = "retry copy failed" + tui.ChromeSep + err.Error()
			return m, nil
		}
		m.status = "copied" + tui.ChromeSep + cmd
		return m, nil
	case "up":
		vp := m.scrollViewport()
		m.detailScroll = runsbrowser.ClampDetailScroll(m.detailScrollLines(), m.detailScroll-1, vp)
		return m, nil
	case "down":
		vp := m.scrollViewport()
		m.detailScroll = runsbrowser.ClampDetailScroll(m.detailScrollLines(), m.detailScroll+1, vp)
		return m, nil
	}
	return m, nil
}

func (m *Model) listViewport() int {
	return m.viewport(listListChrome)
}

func (m *Model) scrollViewport() int {
	return m.viewport(scrollViewChrome)
}

func (m *Model) viewport(chrome int) int {
	h := m.height - chrome
	if h < 3 {
		return 3
	}
	return h
}

func (m *Model) clampWorkflowWindow() {
	m.wfCursor, m.wfOffset = clampWindow(m.wfCursor, m.wfOffset, len(m.visibleEntries()), m.listViewport())
}

func (m *Model) clampRunWindow() {
	m.runCursor, m.runOffset = clampWindow(m.runCursor, m.runOffset, len(m.visibleRuns()), m.listViewport())
}

func clampWindow(cursor, offset, count, vp int) (int, int) {
	if cursor > count-1 {
		cursor = count - 1
	}
	if cursor < 0 {
		cursor = 0
	}
	if cursor < offset {
		offset = cursor
	}
	if cursor >= offset+vp {
		offset = cursor - vp + 1
	}
	return cursor, offset
}

// clampAgentWindow keeps the send-back chooser cursor visible. The shown
// list keeps one row of the viewport for its header.
func (m *Model) clampAgentWindow() {
	vp := max(1, m.scrollViewport()-1)
	if m.agentCursor < m.agentOffset {
		m.agentOffset = m.agentCursor
	}
	if m.agentCursor >= m.agentOffset+vp {
		m.agentOffset = m.agentCursor - vp + 1
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

func (m Model) Body() string {
	return m.render()
}

func (m Model) visibleEntries() []workflow.ListEntry {
	needle := strings.ToLower(m.wfFilter)
	out := make([]workflow.ListEntry, 0, len(m.entries))
	for _, e := range m.entries {
		if e.Hidden {
			continue
		}
		if m.wfFilter != "" {
			title := strings.ToLower(workflow.DisplayTitle(e.Name, e.Title))
			if !strings.Contains(title, needle) && !strings.Contains(strings.ToLower(e.Name), needle) {
				continue
			}
		}
		out = append(out, e)
	}
	return out
}

func (m Model) visibleRuns() []history.Summary {
	if m.runFilter == "" {
		return m.runs
	}
	needle := strings.ToLower(m.runFilter)
	out := make([]history.Summary, 0, len(m.runs))
	for _, r := range m.runs {
		if strings.Contains(strings.ToLower(r.Workflow+" "+r.Title+" "+r.Status), needle) {
			out = append(out, r)
		}
	}
	return out
}

func entryLocation(e workflow.ListEntry) string {
	if e.Error != "" {
		return "invalid"
	}
	if e.Source == "repo" {
		return "repo"
	}
	return "global"
}

func entrySensitive(e workflow.ListEntry) bool {
	return len(workflow.SensitivityLabels(workflow.Sensitivity{
		HasCommands:        e.HasCommands,
		HasTranscript:      e.NeedsTranscript,
		SensitiveMethods:   e.SensitiveMethods,
		UnresolvedChildren: e.UnresolvedChildren,
	})) > 0
}
