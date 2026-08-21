package runsbrowser

import (
	"os"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/history"
)

type screen int

const (
	screenList screen = iota
	screenDetail
)

// Options construct a runs browser model.
type Options struct {
	RepoRoot        string
	Width           int
	Env             config.Env
	LaunchWorkbench func(route string)
}

// Model is the runs browser Bubble Tea model.
type Model struct {
	repoRoot        string
	width           int
	getenv          config.Env
	launchWorkbench func(string)

	screen       screen
	scope        Scope
	filter       string
	cursor       int
	offset       int
	state        State
	activeRunID  string
	detailView   DetailView
	detailScroll int
	detailGen    *config.Generation
	refreshGen   *config.Generation
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

// WorkbenchRoute builds the authenticated workbench hash route for a run id.
func WorkbenchRoute(id string) string {
	return "run=" + strings.ToLower(id)
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
		repoRoot:        opts.RepoRoot,
		width:           width,
		getenv:          getenv,
		launchWorkbench: opts.LaunchWorkbench,
		screen:          screenList,
		scope:           ScopeCurrent,
		detailGen:       &config.Generation{},
		refreshGen:      &config.Generation{},
	}
}

func (m Model) Init() tea.Cmd {
	return m.refreshCmd("")
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
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
			return m.openDetail(item.ID)
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
		m.activeRunID = ""
		return m, m.refreshCmd(preserve)
	case "up":
		m.detailScroll = max(0, m.detailScroll-1)
		return m, nil
	case "down":
		lines := DetailLines(m.detailView, m.contentWidth())
		_, m.detailScroll = ScrollDetailLines(lines, m.detailScroll+1, detailViewport)
		return m, nil
	case "w":
		if msg.Mod != 0 {
			return m, nil
		}
		id := m.activeRunID
		if id == "" {
			return m, nil
		}
		if _, ok := history.NormalizeRunUUID(id); !ok {
			return m, nil
		}
		if !viewAllowsWorkbench(m.detailView) {
			return m, nil
		}
		if m.launchWorkbench != nil {
			m.launchWorkbench(WorkbenchRoute(id))
		}
		return m, nil
	case "tab":
		return m, nil
	}
	return m, nil
}

func (m Model) openDetail(id string) (Model, tea.Cmd) {
	m.screen = screenDetail
	m.activeRunID = id
	m.detailScroll = 0
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
	m.cursor = SelectedIndex(m.state.Items, m.state.SelectedID)
	m.clampCursor()
	m.syncSelectedID()
	return m, nil
}

func (m Model) applyDetailLoaded(msg detailLoadedMsg) (Model, tea.Cmd) {
	if m.screen != screenDetail || m.activeRunID != msg.id || !m.detailGen.Current(msg.gen) {
		return m, nil
	}
	m.detailView = msg.view
	m.detailScroll = 0
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
	n := len(m.state.Items)
	if n == 0 {
		m.cursor = 0
		m.offset = 0
		return
	}
	if m.cursor >= n {
		m.cursor = n - 1
	}
	if m.cursor < 0 {
		m.cursor = 0
	}
	if m.cursor < m.offset {
		m.offset = m.cursor
	}
	if m.cursor >= m.offset+ListViewport {
		m.offset = m.cursor - ListViewport + 1
	}
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

func viewAllowsWorkbench(view DetailView) bool {
	switch view.Kind {
	case "starting", "local-failure", "history-unavailable":
		return false
	default:
		return true
	}
}
