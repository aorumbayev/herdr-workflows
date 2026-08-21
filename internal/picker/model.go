package picker

import (
	"context"
	"os"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/runsbrowser"
	"github.com/aorumbayev/herdr-workflows/internal/tui"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

const ListViewport = 6

type mode int

const (
	modeList mode = iota
	modePalette
	modeDelete
	modeInput
	modeInputText
	modeFail
	modeRun
	modeRuns
)

// Options construct a picker model. CLI wiring of launch/web stays row 10.
type Options struct {
	Entries            []workflow.WorkflowListEntry
	RepoRoot           string
	Config             config.Config
	Width              int
	Env                config.Env
	Chdir              func(string) error
	LoadWorkflow       func(workflow.WorkflowListEntry) (*workflow.Definition, error)
	ReportPaneMetadata func()
	CopyClipboard      func(string) error
}

// Model is the picker Bubble Tea model.
type Model struct {
	entries      []workflow.WorkflowListEntry
	repoRoot     string
	config       config.Config
	width        int
	load         func(workflow.WorkflowListEntry) (*workflow.Definition, error)
	copyText     func(string) error
	env          config.Env
	mode         mode
	filter       string
	cursor       int
	offset       int
	savedFilter  string
	status       string
	session      *workflow.InputSession
	prompt       *workflow.InputPrompt
	promptValue  string
	choiceOpts   []string
	custom       bool
	queue        []workflow.InputSpec
	delete       DeleteState
	quit         bool
	consent      string
	newerRelease bool
	stopResolve  context.CancelFunc
	resolveGen   uint64
	runs         runsbrowser.Model
}

type currentResolvedMsg struct {
	gen    uint64
	result workflow.CurrentResult
}

// NewerReleaseMsg marks the filter row with the hwf update hint.
type NewerReleaseMsg struct{}

// Prepare chdirs into the repo root, then returns a model ready to run.
func Prepare(opts Options) (Model, error) {
	chdir := opts.Chdir
	if chdir == nil {
		chdir = os.Chdir
	}
	if opts.RepoRoot != "" {
		if err := chdir(opts.RepoRoot); err != nil {
			return Model{}, err
		}
	}
	return New(opts), nil
}

// New builds a list-mode picker. It never issues pane.report_metadata.
func New(opts Options) Model {
	width := opts.Width
	if width <= 0 {
		width = 80
	}
	return Model{
		entries:  opts.Entries,
		repoRoot: opts.RepoRoot,
		config:   opts.Config,
		width:    width,
		load:     opts.LoadWorkflow,
		copyText: opts.CopyClipboard,
		env:      opts.Env,
	}
}

func (m Model) Init() tea.Cmd { return nil }

func (m Model) contentWidth() int {
	return max(0, m.width-2)
}

func (m Model) matched() []ChromeOption {
	split := FilterWorkflowEntries(m.entries, m.filter)
	return append(BuildPickerOptions(split.Valid, m.contentWidth()), BuildInvalidOptions(split.Invalid, m.contentWidth())...)
}

func (m Model) selectedEntry() *workflow.WorkflowListEntry {
	opts := m.matched()
	if len(opts) == 0 || m.cursor < 0 || m.cursor >= len(opts) {
		return nil
	}
	e := opts[m.cursor].Entry
	return &e
}

func (m *Model) clampCursor() {
	n := len(m.matched())
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

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		if m.mode == modeRuns {
			return m.forwardRuns(msg)
		}
		return m, nil
	case currentResolvedMsg:
		return m.applyCurrent(msg)
	case NewerReleaseMsg:
		m.newerRelease = true
		return m, nil
	case runsbrowser.SwitchToWorkflowsMsg:
		m.mode = modeList
		return m, nil
	case tea.QuitMsg:
		if m.mode == modeRuns {
			m.quit = true
			return m, tea.Quit
		}
		return m, nil
	case tea.KeyPressMsg:
		return m.handleKey(msg)
	default:
		if m.mode == modeRuns {
			return m.forwardRuns(msg)
		}
	}
	return m, nil
}

func (m Model) handleKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	key := msg.String()
	if key == "ctrl+c" {
		m.abortResolve()
		m.quit = true
		return m, tea.Quit
	}
	switch m.mode {
	case modeRuns:
		return m.forwardRuns(msg)
	case modePalette:
		return m.handlePalette(msg)
	case modeDelete:
		return m.handleDelete(msg)
	case modeInputText:
		return m.handleInputText(msg)
	case modeInput:
		return m.handleInput(msg)
	case modeFail, modeRun:
		if key == "enter" || key == "esc" {
			if m.mode == modeFail || key == "esc" {
				m.mode = modeList
				m.status = ""
			}
			if m.mode == modeRun && key == "esc" {
				m.quit = true
				return m, tea.Quit
			}
		}
		return m, nil
	default:
		return m.handleList(msg)
	}
}

func (m Model) handleList(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	key := msg.String()
	switch key {
	case "up":
		m.moveCursor(-1)
	case "down":
		m.moveCursor(1)
	case "enter":
		return m.acceptCurrent()
	case "ctrl+k":
		m.savedFilter = m.filter
		m.mode = modePalette
	case "tab":
		getenv := m.env
		if getenv == nil {
			getenv = os.Getenv
		}
		m.runs = runsbrowser.New(runsbrowser.Options{
			RepoRoot: m.repoRoot,
			Width:    m.width,
			Env:      getenv,
		})
		m.mode = modeRuns
		return m, m.runs.Init()
	case "esc":
		m.quit = true
		return m, tea.Quit
	case "backspace":
		if m.filter != "" {
			r := []rune(m.filter)
			m.filter = string(r[:len(r)-1])
			m.cursor, m.offset = 0, 0
		}
	default:
		if msg.Mod == 0 && msg.Text != "" {
			m.filter += msg.Text
			m.cursor, m.offset = 0, 0
		}
	}
	return m, nil
}

func (m Model) forwardRuns(msg tea.Msg) (tea.Model, tea.Cmd) {
	next, cmd := m.runs.Update(msg)
	m.runs = next.(runsbrowser.Model)
	return m, cmd
}

func (m *Model) moveCursor(delta int) {
	opts := m.matched()
	n := len(opts)
	if n == 0 {
		return
	}
	m.cursor = (m.cursor + delta + n) % n
	m.clampCursor()
}

func (m Model) handlePalette(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	key := msg.String()
	if key == "esc" {
		m.mode = modeList
		m.filter = m.savedFilter
		m.clampCursor()
		return m, nil
	}
	if msg.Mod != 0 || msg.Text == "" {
		return m, nil
	}
	action := ResolvePaletteLetter(msg.Text, m.selectedEntry())
	if action == nil {
		return m, nil
	}
	if action.ID == "delete" && action.Entry != nil {
		m.delete = DeleteState{PendingDelete: action.Entry}
		m.mode = modeDelete
		return m, nil
	}
	m.mode = modeList
	m.filter = m.savedFilter
	return m, nil
}

func (m Model) handleDelete(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "y":
		m.mode = modeList
		entry := BeginConfirmedDelete(&m.delete)
		if entry == nil {
			return m, nil
		}
		if err := os.Remove(entry.File); err != nil {
			m.status = "delete failed" + tui.ChromeSep + err.Error()
			return m, nil
		}
		m.entries = dropListEntry(m.entries, *entry)
		m.clampCursor()
	case "n", "esc":
		m.delete = DeleteState{}
		m.mode = modeList
	}
	return m, nil
}

func dropListEntry(entries []workflow.WorkflowListEntry, gone workflow.WorkflowListEntry) []workflow.WorkflowListEntry {
	out := make([]workflow.WorkflowListEntry, 0, len(entries))
	for _, entry := range entries {
		if entry.File == gone.File && entry.Name == gone.Name && entry.Source == gone.Source {
			continue
		}
		out = append(out, entry)
	}
	return out
}

func (m Model) handleInput(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	key := msg.String()
	switch key {
	case "up":
		if len(m.choiceOpts) > 0 {
			m.moveChoice(-1)
		}
	case "down":
		if len(m.choiceOpts) > 0 {
			m.moveChoice(1)
		}
	case "enter":
		return m.submitChoice()
	case "esc":
		return m.inputBack()
	case "backspace":
		if m.filter != "" {
			r := []rune(m.filter)
			m.filter = string(r[:len(r)-1])
			m.cursor, m.offset = 0, 0
		}
	default:
		if msg.Mod == 0 && msg.Text != "" {
			m.filter += msg.Text
			m.cursor, m.offset = 0, 0
		}
	}
	return m, nil
}

func (m *Model) moveChoice(delta int) {
	n := len(m.choiceRows())
	if n == 0 {
		return
	}
	m.cursor = (m.cursor + delta + n) % n
	m.clampChoice()
}

func (m *Model) clampChoice() {
	n := len(m.choiceRows())
	if n == 0 {
		m.cursor, m.offset = 0, 0
		return
	}
	if m.cursor >= n {
		m.cursor = n - 1
	}
	if m.cursor < m.offset {
		m.offset = m.cursor
	}
	if m.cursor >= m.offset+ListViewport {
		m.offset = m.cursor - ListViewport + 1
	}
}

func (m Model) choiceRows() []string {
	filtered := FilterChoiceOptions(m.choiceOpts, m.filter)
	if m.custom {
		filtered = append(filtered, tui.CustomChoiceLabel)
	}
	return filtered
}

func (m Model) submitChoice() (tea.Model, tea.Cmd) {
	rows := m.choiceRows()
	if len(rows) == 0 {
		return m, nil
	}
	value := rows[m.cursor]
	if m.custom && value == tui.CustomChoiceLabel {
		m.mode = modeInputText
		m.promptValue = m.filter
		return m, nil
	}
	return m.answer(value)
}

func (m Model) handleInputText(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "enter":
		return m.answer(m.promptValue)
	case "esc":
		m.mode = modeInput
		return m, nil
	case "backspace":
		if m.promptValue != "" {
			r := []rune(m.promptValue)
			m.promptValue = string(r[:len(r)-1])
		}
	default:
		if msg.Mod == 0 && msg.Text != "" {
			m.promptValue += msg.Text
		}
	}
	return m, nil
}

func (m Model) inputBack() (tea.Model, tea.Cmd) {
	m.abortResolve()
	if m.session == nil || !m.session.Back() {
		m.mode = modeList
		m.session = nil
		m.consent = ""
		m.filter = m.savedFilter
		return m, nil
	}
	return m.showCurrent()
}

func (m Model) answer(value string) (tea.Model, tea.Cmd) {
	if m.session == nil {
		return m, nil
	}
	if err := m.session.Answer(value); err != nil {
		m.status = err.Error()
		return m, nil
	}
	m.status = ""
	m.filter = ""
	m.cursor, m.offset = 0, 0
	return m.showCurrent()
}

func (m Model) acceptCurrent() (tea.Model, tea.Cmd) {
	entry := m.selectedEntry()
	if entry == nil || entry.Error != "" {
		return m, nil
	}
	m.consent = FormatConsentLine(*entry)
	if m.load == nil {
		m.mode = modeRun
		m.status = entry.Name
		return m, nil
	}
	loaded, err := m.load(*entry)
	if err != nil {
		m.mode = modeFail
		m.status = "Failed" + tui.ChromeSep + err.Error()
		m.consent = ""
		return m, nil
	}
	m.queue = loaded.Inputs
	if len(loaded.Inputs) == 0 {
		m.mode = modeRun
		m.status = loaded.Name
		return m, nil
	}
	m.savedFilter = m.filter
	m.session = workflow.NewInputSession(workflow.InputSessionOptions{
		Specs:    loaded.Inputs,
		File:     loaded.File,
		Config:   m.config,
		RepoRoot: m.repoRoot,
	})
	return m.showCurrent()
}

func (m *Model) abortResolve() {
	if m.stopResolve != nil {
		m.stopResolve()
		m.stopResolve = nil
	}
	if m.session != nil {
		m.session.CancelPending()
	}
	m.resolveGen++
}

func (m Model) showCurrent() (tea.Model, tea.Cmd) {
	if m.session == nil {
		return m, nil
	}
	m.abortResolve()
	ctx, stop := context.WithCancel(context.Background())
	m.stopResolve = stop
	m.resolveGen++
	gen := m.resolveGen
	sess := m.session
	m.mode = modeInput
	m.choiceOpts = nil
	return m, func() tea.Msg {
		return currentResolvedMsg{gen: gen, result: sess.Current(ctx)}
	}
}

func (m Model) applyCurrent(msg currentResolvedMsg) (tea.Model, tea.Cmd) {
	if msg.gen != m.resolveGen {
		return m, nil
	}
	cur := msg.result
	if cur.Cancelled {
		return m, nil
	}
	if cur.Err != nil {
		m.mode = modeFail
		m.status = cur.Err.Error()
		m.choiceOpts = nil
		return m, nil
	}
	if cur.Done {
		m.mode = modeRun
		if m.consent == "" {
			m.status = "ready"
		}
		return m, nil
	}
	return m.presentPrompt(cur.Prompt)
}

func (m Model) presentPrompt(prompt *workflow.InputPrompt) (tea.Model, tea.Cmd) {
	m.prompt = prompt
	m.choiceOpts = nil
	m.custom = false
	m.filter = ""
	m.cursor, m.offset = 0, 0
	spec := prompt.Spec
	answer, hasAnswer := m.values()[spec.Name]
	if spec.Type == "text" {
		m.mode = modeInputText
		m.promptValue = restoredText(hasAnswer, answer, spec.Default)
		return m, nil
	}
	m.mode = modeInput
	m.choiceOpts = prompt.Options
	m.custom = spec.AllowCustom
	if ShouldRestoreCustomChoiceText(hasAnswer, answer, m.choiceOpts, m.custom) {
		m.mode = modeInputText
		m.promptValue = answer
		return m, nil
	}
	m.cursor = choiceCursor(m.choiceRows(), hasAnswer, answer, spec.Default)
	m.clampChoice()
	return m, nil
}

func restoredText(hasAnswer bool, answer string, fallback *string) string {
	if hasAnswer {
		return answer
	}
	if fallback != nil {
		return *fallback
	}
	return ""
}

func choiceCursor(rows []string, hasAnswer bool, answer string, fallback *string) int {
	if hasAnswer {
		return indexOf(rows, answer)
	}
	if fallback != nil {
		return indexOf(rows, *fallback)
	}
	return 0
}

func indexOf(items []string, want string) int {
	for i, item := range items {
		if item == want {
			return i
		}
	}
	return 0
}

// FilterInput drops leaked C0 prefix-key bytes after Bubble Tea parses them.
func FilterInput(_ tea.Model, msg tea.Msg) tea.Msg {
	k, ok := msg.(tea.KeyPressMsg)
	if !ok {
		return msg
	}
	seq := keySequence(k)
	if seq != "" && ShouldDropStdinLeakSequence(seq) {
		return nil
	}
	return msg
}

func keySequence(k tea.KeyPressMsg) string {
	if k.Mod == tea.ModCtrl && k.Code >= 'a' && k.Code <= 'z' {
		return string(rune(k.Code - 'a' + 1))
	}
	switch k.Code {
	case tea.KeyTab:
		return "\t"
	case tea.KeyEnter:
		return "\n"
	case tea.KeyEscape:
		return "\x1b"
	}
	if k.Mod == 0 && len(k.Text) == 1 {
		return k.Text
	}
	return ""
}
