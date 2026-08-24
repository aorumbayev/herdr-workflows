package runsbrowser

import (
	"os"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/history"
	"github.com/aorumbayev/herdr-workflows/internal/tui"
)

type screen int

const (
	screenList screen = iota
	screenDetail
)

// Options construct a runs browser model.
type Options struct {
	RepoRoot   string
	Width      int
	Height     int
	Env        config.Env
	SelectedID string
}

// Model is the runs browser Bubble Tea model.
type Model struct {
	repoRoot     string
	width        int
	height       int
	getenv       config.Env
	screen       screen
	scope        Scope
	filter       string
	cursor       int
	offset       int
	state        State
	activeRunID  string
	detailView   DetailView
	detailScroll int
	yamlScroll   int
	yamlChunks   []string
	stepFocus    int
	detailGen    *config.Generation
	refreshGen   *config.Generation
	selectedID   string
}

// SwitchToWorkflowsMsg tells the picker to return to the workflow list.
type SwitchToWorkflowsMsg struct{}

type listLoadedMsg struct {
	gen    int64
	scope  Scope
	filter string
	state  State
}

type detailLoadedMsg struct {
	gen  int64
	id   string
	view DetailView
}

// New builds a list-mode runs browser.
func New(opts Options) Model {
	width := opts.Width
	if width <= 0 {
		width = 80
	}
	getenv := opts.Env
	if getenv == nil {
		getenv = os.Getenv
	}
	return Model{
		repoRoot:   opts.RepoRoot,
		width:      width,
		height:     opts.Height,
		getenv:     getenv,
		screen:     screenList,
		scope:      ScopeCurrent,
		detailGen:  &config.Generation{},
		refreshGen: &config.Generation{},
		selectedID: opts.SelectedID,
	}
}

func (m Model) Init() tea.Cmd {
	return m.refreshCmd(m.selectedID)
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		if m.screen == screenList {
			return m, m.refreshCmd(m.preserveSelection())
		}
		return m, nil
	case listLoadedMsg:
		return m.applyListLoaded(msg)
	case detailLoadedMsg:
		return m.applyDetailLoaded(msg)
	case tea.KeyPressMsg:
		return m.handleKey(msg)
	}
	return m, nil
}

func (m Model) handleKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	key := msg.String()
	if key == "ctrl+c" {
		return m, tea.Quit
	}
	if m.screen == screenDetail {
		return m.handleDetailKey(msg)
	}
	return m.handleListKey(msg)
}

func (m Model) handleListKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	key := msg.String()
	switch key {
	case "tab":
		return m, func() tea.Msg { return SwitchToWorkflowsMsg{} }
	case "ctrl+g":
		if m.scope == ScopeCurrent {
			m.scope = ScopeAll
		} else {
			m.scope = ScopeCurrent
		}
		return m, m.refreshCmd(m.preserveSelection())
	case "up":
		m.moveCursor(-1)
		m.syncSelectedID()
		return m, nil
	case "down":
		m.moveCursor(1)
		m.syncSelectedID()
		return m, nil
	case "enter":
		if item := m.selectedItem(); item != nil {
			return m.OpenDetail(item.ID)
		}
		return m, nil
	case "esc":
		return m, tea.Quit
	case "backspace":
		if m.filter != "" {
			r := []rune(m.filter)
			m.filter = string(r[:len(r)-1])
			m.cursor, m.offset = 0, 0
			return m, m.refreshCmd("")
		}
		return m, nil
	default:
		if msg.Mod == 0 && msg.Text != "" {
			m.filter += msg.Text
			m.cursor, m.offset = 0, 0
			return m, m.refreshCmd("")
		}
	}
	return m, nil
}

func (m Model) handleDetailKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	key := msg.String()
	switch key {
	case "esc":
		preserve := m.activeRunID
		m.screen = screenList
		m.detailView = DetailView{}
		m.detailScroll = 0
		m.yamlScroll = 0
		m.yamlChunks = nil
		m.stepFocus = 0
		m.activeRunID = ""
		return m, m.refreshCmd(preserve)
	case "up":
		if stepCount(m.detailView.Detail) > 0 {
			m.moveStepFocus(-1)
			return m, nil
		}
		m.detailScroll = max(0, m.detailScroll-1)
		return m, nil
	case "down":
		if stepCount(m.detailView.Detail) > 0 {
			m.moveStepFocus(1)
			return m, nil
		}
		lines := DetailLines(m.detailView, m.contentWidth())
		_, m.detailScroll = ScrollDetailLines(lines, m.detailScroll+1, m.detailRows())
		return m, nil
	case "pgup":
		m.yamlScroll = max(0, m.yamlScroll-1)
		return m, nil
	case "pgdown":
		if step, ok := focusedStep(m.detailView.Detail, m.stepFocus); ok {
			_, rightW := tui.RailSplit(m.contentWidth())
			lines := detailPaneLines(m.detailView.Detail, step, m.yamlChunks, rightW)
			_, m.yamlScroll = ScrollDetailLines(lines, m.yamlScroll+1, m.detailRows())
		}
		return m, nil
	case "tab":
		return m, nil
	}
	return m, nil
}

func (m Model) OpenDetail(id string) (Model, tea.Cmd) {
	m.screen = screenDetail
	m.activeRunID = id
	m.detailScroll = 0
	m.yamlScroll = 0
	m.stepFocus = 0
	gen := m.detailGen.Begin()
	getenv := m.getenv
	return m, func() tea.Msg {
		presented := history.RunDetail(id, getenv, time.Time{})
		return detailLoadedMsg{
			gen: gen,
			id:  id,
			view: DetailView{
				Kind:     "detail",
				ID:       presented.Detail.ID,
				Workflow: presented.Detail.Workflow,
				Detail:   presented.Detail,
				Blocks:   presented.Blocks,
			},
		}
	}
}

func (m Model) applyListLoaded(msg listLoadedMsg) (Model, tea.Cmd) {
	if !m.refreshGen.Current(msg.gen) || m.screen != screenList || m.scope != msg.scope || m.filter != msg.filter {
		return m, nil
	}
	m.state = msg.state
	want := m.state.SelectedID
	m.cursor = SelectedIndex(m.state.Items, want)
	m.clampCursor()
	if want != "" && !idInItems(m.state.Items, want) {
		m.state.SelectedID = want
		return m, nil
	}
	m.syncSelectedID()
	return m, nil
}

func idInItems(items []history.Summary, id string) bool {
	for _, item := range items {
		if item.ID == id {
			return true
		}
	}
	return false
}

func (m Model) applyDetailLoaded(msg detailLoadedMsg) (Model, tea.Cmd) {
	if m.screen != screenDetail || m.activeRunID != msg.id || !m.detailGen.Current(msg.gen) {
		return m, nil
	}
	m.detailView = msg.view
	m.detailScroll = 0
	m.yamlScroll = 0
	m.stepFocus = defaultStepFocus(msg.view.Detail)
	arts, _ := history.LoadDebugArtifacts(msg.id, m.getenv)
	m.yamlChunks = tui.SplitStepYAML(arts.EntryYAML)
	return m, nil
}

func (m Model) refreshCmd(preserveID string) tea.Cmd {
	gen := m.refreshGen.Begin()
	scope := m.scope
	filter := m.filter
	repoRoot := m.repoRoot
	getenv := m.getenv
	return func() tea.Msg {
		state := Load(repoRoot, scope, filter, preserveID, getenv)
		return listLoadedMsg{gen: gen, scope: scope, filter: filter, state: state}
	}
}

func (m *Model) moveCursor(delta int) {
	n := len(m.state.Items)
	if n == 0 {
		return
	}
	m.cursor = (m.cursor + delta + n) % n
	m.clampCursor()
}

func (m *Model) clampCursor() {
	m.cursor, m.offset = tui.ClampListWindow(m.cursor, m.offset, len(m.state.Items), m.listViewport())
}

// listChrome is the filter, two blanks, detail rows, rule, and footer.
const listChrome = 7

// listViewport fills the host with run rows above the six-row floor.
func (m Model) listViewport() int {
	return tui.FitViewport(m.height, listChrome, ListViewport)
}

// detailRows fills the host with detail lines above the ten-row floor. Only the
// rule and the footer sit under them.
func (m Model) detailRows() int {
	return tui.FitViewport(m.height, 2, detailViewport)
}

func (m *Model) syncSelectedID() {
	if item := m.selectedItem(); item != nil {
		m.state.SelectedID = item.ID
	}
}

func (m Model) selectedItem() *history.Summary {
	if len(m.state.Items) == 0 || m.cursor < 0 || m.cursor >= len(m.state.Items) {
		return nil
	}
	item := m.state.Items[m.cursor]
	return &item
}

func (m Model) preserveSelection() string {
	if m.state.SelectedID != "" {
		return m.state.SelectedID
	}
	if item := m.selectedItem(); item != nil {
		return item.ID
	}
	return m.activeRunID
}

// OpenLocalDetail replaces the browser with a local detail screen that is not from history.
func (m Model) OpenLocalDetail(view DetailView) Model {
	m.screen = screenDetail
	m.activeRunID = view.ID
	m.detailView = view
	m.detailScroll = 0
	m.yamlScroll = 0
	m.yamlChunks = nil
	m.stepFocus = defaultStepFocus(view.Detail)
	m.state.SelectedID = view.ID
	return m
}

// ApplyLocalDetail updates the open detail without leaving detail mode.
func (m Model) ApplyLocalDetail(view DetailView) Model {
	if view.ID == "" {
		view.ID = m.activeRunID
	}
	m.detailView = view
	m.activeRunID = view.ID
	m.state.SelectedID = view.ID
	m.detailScroll = 0
	m.yamlScroll = 0
	m.stepFocus = defaultStepFocus(view.Detail)
	return m
}

// IsList reports list screen (not detail).
func (m Model) IsList() bool { return m.screen == screenList }

// ActiveRunID is the detail identity when detail is open.
func (m Model) ActiveRunID() string { return m.activeRunID }

// SelectedID is the list selection (or last detail id after return).
func (m Model) SelectedID() string { return m.state.SelectedID }

// DetailWorkflow is the workflow title on the open detail view.
func (m Model) DetailWorkflow() string { return m.detailView.Workflow }

// DetailKind is the open detail view kind.
func (m Model) DetailKind() string { return m.detailView.Kind }

func (m *Model) moveStepFocus(delta int) {
	n := stepCount(m.detailView.Detail)
	if n == 0 {
		return
	}
	m.stepFocus = min(max(m.stepFocus+delta, 0), n-1)
	m.yamlScroll = 0
	leftW, _ := tui.RailSplit(m.contentWidth())
	m.detailScroll = tui.RailScrollIntoView(detailCards(m.detailView.Detail, m.stepFocus), m.stepFocus, leftW, m.detailRows(), m.detailScroll)
}

func (m Model) FocusedFailure() (history.Detail, history.DetailStep, string, bool) {
	if m.screen != screenDetail {
		return history.Detail{}, history.DetailStep{}, "", false
	}
	d := m.detailView.Detail
	if d.Status != "failed" && d.Status != "interrupted" {
		return history.Detail{}, history.DetailStep{}, "", false
	}
	step, ok := focusedStep(d, m.stepFocus)
	if !ok {
		return history.Detail{}, history.DetailStep{}, "", false
	}
	return d, step, stepSource(m.yamlChunks, step), true
}
