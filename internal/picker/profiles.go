package picker

import (
	"os"
	"strings"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/tui"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

var newProfileScopeOptions = []string{"global", "repo", "local"}

func (m Model) getenv() config.Env {
	if m.env != nil {
		return m.env
	}
	return os.Getenv
}

func (m Model) openProfilesTab() (tea.Model, tea.Cmd) {
	entries, err := config.ListProfiles(m.repoRoot, m.getenv())
	m.profileEntries = entries
	m.mode = modeProfiles
	m.filter = ""
	m.cursor, m.offset = 0, 0
	m.hoverRow = -1
	if err != nil {
		m.status = "profiles unavailable" + tui.ChromeSep + err.Error()
	} else {
		m.status = ""
	}
	return m, nil
}

func (m Model) refreshProfiles() Model {
	if entries, err := config.ListProfiles(m.repoRoot, m.getenv()); err == nil {
		m.profileEntries = entries
	}
	return m
}

func (m Model) filteredProfiles() []config.ProfileEntry {
	if m.filter == "" {
		return m.profileEntries
	}
	needle := strings.ToLower(m.filter)
	var out []config.ProfileEntry
	for _, p := range m.profileEntries {
		if strings.Contains(strings.ToLower(p.Name), needle) {
			out = append(out, p)
		}
	}
	return out
}

func (m Model) selectedProfile() *config.ProfileEntry {
	list := m.filteredProfiles()
	if len(list) == 0 || m.cursor < 0 || m.cursor >= len(list) {
		return nil
	}
	p := list[m.cursor]
	return &p
}

func (m *Model) moveProfileCursor(delta int) {
	n := len(m.filteredProfiles())
	if n == 0 {
		return
	}
	m.cursor = (m.cursor + delta + n) % n
	m.cursor, m.offset = tui.ClampListWindow(m.cursor, m.offset, n, m.listViewport())
}

func (m Model) handleProfilesKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "up":
		m.moveProfileCursor(-1)
	case "down":
		m.moveProfileCursor(1)
	case "enter":
		return m.beginProfileOpen()
	case "ctrl+p":
		m.mode = modeProfilePalette
		m.status = ""
	case "tab":
		return m.cycleRootTab()
	case "shift+tab":
		return m.cycleRootTabBack()
	case "esc":
		m.quit = true
		return m, tea.Quit
	case "backspace":
		if m.filter != "" {
			m.filter = tui.TrimLastRune(m.filter)
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

func (m Model) handleProfilePalette(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	key := msg.String()
	if key == "esc" {
		m.mode = modeProfiles
		return m, nil
	}
	if msg.Mod != 0 || msg.Text == "" {
		return m, nil
	}
	switch strings.ToLower(msg.Text) {
	case "n":
		m.mode = modeNewProfileName
		m.promptValue = ""
		m.status = ""
		return m, nil
	case "o":
		return m.beginProfileOpen()
	}
	return m, nil
}

func (m Model) beginProfileOpen() (tea.Model, tea.Cmd) {
	p := m.selectedProfile()
	if p == nil {
		m.mode = modeProfiles
		return m, nil
	}
	return m.beginEditPlacement(p.File, p.Name, true, modeProfiles)
}

func (m Model) handleNewProfileName(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "enter":
		name := strings.TrimSpace(m.promptValue)
		if !config.ProfileNameRE.MatchString(name) {
			m.status = "profile name must match [a-z][a-z0-9_-]{0,31}"
			return m, nil
		}
		m.newName = name
		m.newProfileScopeCursor = 0
		m.mode = modeNewProfileScope
		m.status = ""
		return m, nil
	case "esc":
		m.mode = modeProfiles
		m.promptValue = ""
		m.status = ""
		return m, nil
	case "backspace":
		m.promptValue = tui.TrimLastRune(m.promptValue)
	default:
		if msg.Mod == 0 && msg.Text != "" {
			m.promptValue += msg.Text
		}
	}
	return m, nil
}

func (m Model) handleNewProfileScope(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		m.mode = modeNewProfileName
		m.status = ""
		return m, nil
	case "up":
		m.newProfileScopeCursor = tui.StepCursor(m.newProfileScopeCursor, -1, len(newProfileScopeOptions))
		return m, nil
	case "down":
		m.newProfileScopeCursor = tui.StepCursor(m.newProfileScopeCursor, 1, len(newProfileScopeOptions))
		return m, nil
	case "enter":
		return m.createProfile()
	}
	return m, nil
}

func (m Model) createProfile() (tea.Model, tea.Cmd) {
	scope := newProfileScopeOptions[m.newProfileScopeCursor]
	path, err := config.ConfigPathForScope(scope, m.repoRoot, m.getenv())
	if err != nil {
		m.status = err.Error()
		m.mode = modeProfiles
		return m, nil
	}
	if scope == "local" {
		if err := config.EnsureLocalConfigGitignored(m.repoRoot); err != nil {
			m.status = "profile create failed" + tui.ChromeSep + err.Error()
			m.mode = modeProfiles
			return m, nil
		}
	}
	if err := config.AppendProfileSkeleton(path, m.newName); err != nil {
		m.status = "profile create failed" + tui.ChromeSep + err.Error()
		m.mode = modeProfiles
		return m, nil
	}
	m = m.refreshProfiles()
	m.promptValue = ""
	return m.beginEditPlacement(path, m.newName, true, modeProfiles)
}

func (m Model) beginProfileEdit(path, name string) tea.Cmd {
	repoRoot := m.repoRoot
	getenv := m.getenv()
	validate := func() workflow.ValidateResult {
		if _, err := config.LoadConfig(repoRoot, getenv); err != nil {
			return workflow.ValidateResult{Error: err.Error()}
		}
		return workflow.ValidateResult{OK: true}
	}
	if m.editConfig != nil {
		editConfig := m.editConfig
		return func() tea.Msg {
			if err := editConfig(path); err != nil {
				return editorDoneMsg{name: name, result: workflow.ValidateResult{Error: err.Error()}}
			}
			return editorDoneMsg{name: name, result: validate()}
		}
	}
	editor, err := workflow.ResolveEditor(getenv)
	if err != nil {
		return func() tea.Msg {
			return editorDoneMsg{name: name, result: workflow.ValidateResult{Error: err.Error()}}
		}
	}
	cmd, err := editorCommand(editor, path)
	if err != nil {
		return func() tea.Msg {
			return editorDoneMsg{name: name, result: workflow.ValidateResult{Error: err.Error()}}
		}
	}
	return tea.ExecProcess(cmd, func(err error) tea.Msg {
		if err != nil {
			return editorDoneMsg{name: name, result: workflow.ValidateResult{Error: err.Error()}}
		}
		return editorDoneMsg{name: name, result: validate()}
	})
}

func (m Model) renderProfiles() string {
	w := m.contentWidth()
	list := m.filteredProfiles()
	filterLabel := m.filter
	if filterLabel == "" {
		filterLabel = tui.FilterProfiles
	}
	filter := tui.Truncate(filterLabel, w)
	if len(m.profileEntries) == 0 {
		parts := []string{tui.FormatDetailBlock(tui.ProfilesEmptyMessage, w)}
		if m.status != "" {
			parts = append(parts, tui.Truncate(m.status, w))
		}
		parts = append(parts, tui.FormatRule(w), tui.MuteChrome(tui.FormatListFooter(w, 0, 0, tui.ProfilesEmptyHint)))
		return strings.Join(parts, "\n")
	}
	if len(list) == 0 {
		return filter + "\n\n" + tui.FormatDetailBlock("No profiles matching "+m.filter, w) + "\n" + tui.FormatRule(w) + "\n" + tui.MuteChrome(tui.FormatListFooter(w, 0, 0, tui.ProfilesListHint))
	}
	vp := m.listViewport()
	end := min(m.offset+vp, len(list))
	var rows []string
	for i := m.offset; i < end; i++ {
		rows = append(rows, tui.FormatStyledRow(list[i].Name, list[i].Source, false, w, i == m.cursor, false))
	}
	for len(rows) < vp {
		rows = append(rows, "")
	}
	detail := tui.FormatDetailBlock(m.profileDetail(list[m.cursor]), w)
	footer := tui.MuteChrome(tui.FormatListFooter(w, m.cursor, len(list), tui.ProfilesListHint))
	parts := []string{filter, "", strings.Join(rows, "\n"), "", detail, tui.Truncate(m.status, w), tui.FormatRule(w), footer}
	return strings.Join(parts, "\n")
}

func (m Model) profileDetail(p config.ProfileEntry) string {
	return "kind: " + p.Kind + tui.ChromeSep + "args: " + profileArgsSummary(p) + tui.ChromeSep + p.Source
}

func (m Model) renderProfilePalette() string {
	w := m.contentWidth()
	rows := []string{paletteRow("n", "new", w)}
	if m.selectedProfile() != nil {
		rows = append(rows, paletteRow("o", "open", w))
	}
	body := strings.Join(rows, "\n")
	return body + "\n" + tui.FormatRule(w) + "\n" + tui.MuteChrome(tui.FormatListFooter(w, 0, 0, tui.PaletteHint))
}

func (m Model) renderNewProfileName() string {
	w := m.contentWidth()
	line := "Profile name: " + m.promptValue
	if m.status != "" {
		return tui.Truncate(line, w) + "\n" + tui.Truncate(m.status, w) + "\n" + tui.CreateNameHint
	}
	return tui.Truncate(line, w) + "\n" + tui.CreateNameHint
}

func (m Model) renderNewProfileScope() string {
	w := m.contentWidth()
	body := formatChooserBody("save profile at", newProfileScopeOptions, m.newProfileScopeCursor)
	footer := tui.FormatListFooter(w, m.newProfileScopeCursor, len(newProfileScopeOptions), "enter select"+tui.ChromeSep+"esc back")
	return body + "\n" + tui.FormatRule(w) + "\n" + footer
}

func profileArgsSummary(p config.ProfileEntry) string {
	if len(p.Args) == 0 {
		return "no args"
	}
	return strings.Join(p.Args, " ")
}
