package picker

import (
	"context"
	"os"
	"os/exec"
	"strings"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/runsbrowser"
	"github.com/aorumbayev/herdr-workflows/internal/tui"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

const ListViewport = tui.ListViewport

type mode int

const (
	modeList mode = iota
	modePalette
	modeDelete
	modeInput
	modeInputText
	modeNewName
	modeFail
	modeRuns
)

// Options construct a picker model.
type Options struct {
	Entries       []workflow.WorkflowListEntry
	RepoRoot      string
	Config        config.Config
	Width         int
	Height        int
	Env           config.Env
	Chdir         func(string) error
	LoadWorkflow  func(workflow.WorkflowListEntry) (*workflow.Definition, error)
	CopyClipboard func(string) error
	EditWorkflow  func(path, name string) workflow.ValidateResult
	OpenURL       func(url string) error
	Notify        func(title string, body ...string) error
	LaunchRun     func(LaunchRunOpts) LaunchRunHandle
	AllocateRunID func() string
	ExportShare   func(entry workflow.WorkflowListEntry) (command string, err error)
}

// Model is the picker Bubble Tea model.
type Model struct {
	entries        []workflow.WorkflowListEntry
	repoRoot       string
	config         config.Config
	width          int
	height         int
	load           func(workflow.WorkflowListEntry) (*workflow.Definition, error)
	copyText       func(string) error
	env            config.Env
	editWorkflow   func(path, name string) workflow.ValidateResult
	openURL        func(string) error
	notify         func(title string, body ...string) error
	launchRun      func(LaunchRunOpts) LaunchRunHandle
	allocateRunID  func() string
	exportShare    func(entry workflow.WorkflowListEntry) (command string, err error)
	mode           mode
	filter         string
	cursor         int
	offset         int
	savedFilter    string
	status         string
	session        *workflow.InputSession
	prompt         *workflow.InputPrompt
	promptValue    string
	choiceOpts     []string
	custom         bool
	queue          []workflow.InputSpec
	delete         DeleteState
	quit           bool
	consent        string
	newerRelease   bool
	stopResolve    context.CancelFunc
	resolveGen     uint64
	runs           runsbrowser.Model
	launchRunID    string
	launchDetach   func()
	launchAcks     <-chan string
	launchSettled  <-chan LaunchSettled
	launchProgress <-chan string
	pendingDef     *workflow.Definition
}

type currentResolvedMsg struct {
	gen    uint64
	result workflow.CurrentResult
}

type editorDoneMsg struct {
	name   string
	result workflow.ValidateResult
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
		entries:       opts.Entries,
		repoRoot:      opts.RepoRoot,
		config:        opts.Config,
		width:         width,
		height:        opts.Height,
		load:          opts.LoadWorkflow,
		copyText:      opts.CopyClipboard,
		env:           opts.Env,
		editWorkflow:  opts.EditWorkflow,
		openURL:       opts.OpenURL,
		notify:        opts.Notify,
		launchRun:     opts.LaunchRun,
		allocateRunID: opts.AllocateRunID,
		exportShare:   opts.ExportShare,
	}
}

func (m Model) Init() tea.Cmd { return nil }

func (m Model) contentWidth() int {
	return tui.ContentWidth(m.width)
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
	m.cursor, m.offset = tui.ClampListWindow(m.cursor, m.offset, len(m.matched()), ListViewport)
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		if m.mode == modeRuns {
			return m.forwardRuns(msg)
		}
		return m, nil
	case currentResolvedMsg:
		return m.applyCurrent(msg)
	case editorDoneMsg:
		return m.applyEditorDone(msg)
	case NewerReleaseMsg:
		m.newerRelease = true
		return m, nil
	case launchAckMsg:
		return m.applyLaunchAck(msg)
	case launchSettledMsg:
		return m.applyLaunchSettled(msg)
	case launchProgressMsg:
		return m, m.listenLaunch()
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
		return m.handleRunsKey(msg)
	case modePalette:
		return m.handlePalette(msg)
	case modeDelete:
		return m.handleDelete(msg)
	case modeNewName:
		return m.handleNewName(msg)
	case modeInputText:
		return m.handleInputText(msg)
	case modeInput:
		return m.handleInput(msg)
	case modeFail:
		if key == "enter" || key == "esc" {
			m.mode = modeList
			m.status = ""
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
			Height:   m.height,
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

func (m Model) handleRunsKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	if msg.String() == "esc" && !m.runs.IsList() {
		m.detachLaunch()
	}
	return m.forwardRuns(msg)
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
	return m.applyPaletteAction(action)
}

func (m Model) applyPaletteAction(action *PaletteAction) (tea.Model, tea.Cmd) {
	switch action.ID {
	case "new":
		m.mode = modeNewName
		m.filter = m.savedFilter
		m.promptValue = ""
		m.status = ""
		return m, nil
	case "import":
		m.mode = modeList
		m.filter = m.savedFilter
		m.status = `import with: hwf workflow import "..."`
		return m, nil
	case "open":
		return m.applyEditAction(action.Entry)
	case "examples":
		if m.openURL != nil {
			_ = m.openURL(config.ExamplesURL)
		}
		m.mode = modeList
		m.filter = m.savedFilter
		return m, nil
	case "share":
		return m.applyShareAction(action.Entry)
	default:
		m.mode = modeList
		m.filter = m.savedFilter
		return m, nil
	}
}

func (m Model) applyEditAction(entry *workflow.WorkflowListEntry) (tea.Model, tea.Cmd) {
	m.mode = modeList
	m.filter = m.savedFilter
	if entry == nil {
		return m, nil
	}
	return m, m.beginEdit(entry.File, entry.Name)
}

func (m Model) beginEdit(path, name string) tea.Cmd {
	if m.editWorkflow != nil {
		return func() tea.Msg {
			return editorDoneMsg{name: name, result: m.editWorkflow(path, name)}
		}
	}
	getenv := m.env
	if getenv == nil {
		getenv = os.Getenv
	}
	editor, err := workflow.ResolveEditor(getenv)
	if err != nil {
		return func() tea.Msg {
			return editorDoneMsg{name: name, result: workflow.ValidateResult{Error: err.Error()}}
		}
	}
	repoRoot := m.repoRoot
	return tea.ExecProcess(exec.Command(editor, path), func(err error) tea.Msg {
		if err != nil {
			return editorDoneMsg{name: name, result: workflow.ValidateResult{Error: err.Error()}}
		}
		return editorDoneMsg{name: name, result: workflow.ValidateFile(path, name, repoRoot)}
	})
}

func (m Model) applyEditorDone(msg editorDoneMsg) (tea.Model, tea.Cmd) {
	if msg.result.OK {
		m.status = "validated " + msg.name
	} else {
		m.status = "validate failed" + tui.ChromeSep + msg.result.Error
	}
	return m, nil
}

func (m Model) handleNewName(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "enter":
		name := strings.TrimSpace(m.promptValue)
		if !workflow.NameRE.MatchString(name) {
			m.status = workflow.NameRule
			return m, nil
		}
		path, err := workflow.CreateRepoWorkflow(m.repoRoot, name)
		if err != nil {
			m.status = err.Error()
			m.mode = modeList
			return m, nil
		}
		entry := workflow.WorkflowListEntry{Name: name, Source: "repo", File: path}
		m.entries = append(m.entries, entry)
		m.mode = modeList
		m.promptValue = ""
		return m, m.beginEdit(path, name)
	case "esc":
		m.mode = modeList
		m.promptValue = ""
		m.status = ""
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

func (m Model) applyShareAction(entry *workflow.WorkflowListEntry) (tea.Model, tea.Cmd) {
	m.mode = modeList
	m.filter = m.savedFilter
	if entry == nil {
		return m, nil
	}
	var (
		cmdText string
		err     error
	)
	if m.exportShare != nil {
		cmdText, err = m.exportShare(*entry)
	} else {
		m.status = "share unavailable"
		return m, nil
	}
	if err != nil {
		m.status = "share failed" + tui.ChromeSep + err.Error()
		if m.notify != nil {
			_ = m.notify("herdr-workflows", "Share failed: "+err.Error())
		}
		return m, nil
	}
	copyFn := m.copyText
	if copyFn == nil {
		m.status = "share failed" + tui.ChromeSep + "no clipboard"
		return m, nil
	}
	if err := copyFn(cmdText); err != nil {
		m.status = "share failed" + tui.ChromeSep + err.Error()
		if m.notify != nil {
			_ = m.notify("herdr-workflows", "Share failed: "+err.Error())
		}
		return m, nil
	}
	body := "Workflow " + entry.Name + " has been copied to the clipboard"
	if m.notify != nil {
		_ = m.notify("herdr-workflows", body)
	}
	m.status = body
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
	m.cursor, m.offset = tui.ClampListWindow(m.cursor, m.offset, len(m.choiceRows()), ListViewport)
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
		return m.beginLaunch(&workflow.Definition{Name: entry.Name, Title: entry.Title}, nil, nil)
	}
	loaded, err := m.load(*entry)
	if err != nil {
		m.mode = modeFail
		m.status = "Failed" + tui.ChromeSep + err.Error()
		m.consent = ""
		return m, nil
	}
	m.pendingDef = loaded
	m.queue = loaded.Inputs
	if len(loaded.Inputs) == 0 {
		return m.beginLaunch(loaded, nil, nil)
	}
	m.savedFilter = m.filter
	m.filter = ""
	m.cursor, m.offset = 0, 0
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
		def := m.pendingDef
		if def == nil {
			def = &workflow.Definition{Name: "ready"}
		}
		values := m.session.Values()
		domains := m.session.Domains()
		m.session = nil
		return m.beginLaunch(def, values, domains)
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
