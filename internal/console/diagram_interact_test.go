package console

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/tui"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

func openHandoffDiagram(t *testing.T, opts ...func(*Options)) Model {
	t.Helper()
	def := handoffDefinition(t)
	o := Options{
		RepoRoot: t.TempDir(),
		Entries: []workflow.ListEntry{
			{Name: "handoff", Title: "Handoff", Source: "repo"},
		},
		Width:  80,
		Height: 24,
		LoadWorkflow: func(entry workflow.ListEntry) (*workflow.Definition, error) {
			return def, nil
		},
		ListAgentPanes: func() ([]AgentPaneEntry, error) {
			return []AgentPaneEntry{{PaneID: "agent-1", Title: "Claude"}}, nil
		},
		PaneSendText: func(paneID, text string) error { return nil },
	}
	for _, fn := range opts {
		fn(&o)
	}
	m := New(o)
	next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	return next.(Model)
}

func TestColorYAMLHighlightsKeys(t *testing.T) {
	got := tui.ColorYAML("id: brief\nagent: hello\n")
	if got == "id: brief\nagent: hello\n" {
		t.Fatal("expected ANSI coloring")
	}
	if !strings.Contains(got, "id") || !strings.Contains(got, "brief") {
		t.Fatalf("colored = %q", got)
	}
}

func TestModelConsoleViewEnablesMouseReporting(t *testing.T) {
	m := New(Options{Width: 80, Height: 24})
	if m.View().MouseMode != tea.MouseModeAllMotion {
		t.Fatalf("MouseMode = %v", m.View().MouseMode)
	}
}

func TestModelDiagramClickFocusesCard(t *testing.T) {
	m := openHandoffDiagram(t)
	_, hits := renderRailYAML(m.diagram, m.diagramYAML, m.diagramMarks(), m.contentWidth(), m.scrollViewport(), m.diagramScroll)
	var card railHit
	found := false
	for _, h := range hits {
		if h.Index == 1 {
			card = h
			found = true
			break
		}
	}
	if !found {
		t.Fatal("second card hit missing")
	}
	next, _ := m.ApplyMouse(tea.MouseClickMsg{
		Button: tea.MouseLeft,
		X:      card.X0 + tui.ChromePaddingX,
		Y:      card.Y0 + 1,
	})
	m = next
	if m.diagramFocus.Index != 1 {
		t.Fatalf("focus = %+v, want card 1", m.diagramFocus)
	}
}

func TestModelDiagramCtrlClickTogglesSelection(t *testing.T) {
	body := "version: v1alpha1\ntitle: Two\nsteps:\n  - id: alpha\n    run: [echo, a]\n  - id: beta\n    run: [echo, b]\n"
	def, err := workflow.ParseWorkflowText("two", body, config.Config{}, t.TempDir(), "two.yaml")
	if err != nil {
		t.Fatal(err)
	}
	m := New(Options{
		RepoRoot: t.TempDir(),
		Entries:  []workflow.ListEntry{{Name: "two", Title: "Two", Source: "repo"}},
		Width:    80,
		Height:   40,
		LoadWorkflow: func(entry workflow.ListEntry) (*workflow.Definition, error) {
			return def, nil
		},
	})
	next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = next.(Model)
	_, hits := renderRailYAML(m.diagram, m.diagramYAML, m.diagramMarks(), m.contentWidth(), m.scrollViewport(), m.diagramScroll)
	click := func(h railHit, ctrl bool) {
		msg := tea.MouseClickMsg{Button: tea.MouseLeft, X: h.X0 + tui.ChromePaddingX, Y: h.Y0 + 1}
		if ctrl {
			msg.Mod = tea.ModCtrl
		}
		next, _ := m.ApplyMouse(msg)
		m = next
	}
	ids := []railHit{}
	for _, h := range hits {
		if h.Step != "" {
			ids = append(ids, h)
		}
	}
	if len(ids) < 2 {
		t.Fatalf("need two id cards, got %d", len(ids))
	}
	click(ids[0], true)
	click(ids[1], true)
	if !m.diagramSelected[ids[0].Step] || !m.diagramSelected[ids[1].Step] {
		t.Fatalf("selected = %#v", m.diagramSelected)
	}
}

func TestModelDiagramWheelScrolls(t *testing.T) {
	m := openHandoffDiagram(t)
	before := m.diagramScroll
	next, _ := m.ApplyMouse(tea.MouseWheelMsg{Button: tea.MouseWheelDown})
	m = next
	if m.diagramScroll <= before {
		t.Fatalf("scroll = %d, want > %d", m.diagramScroll, before)
	}
}

func TestModelDiagramASksInsertSide(t *testing.T) {
	m := openHandoffDiagram(t)
	next, _ := m.Update(keyRune('a'))
	m = next.(Model)
	if m.diagramMode != diagramModeInsertSide {
		t.Fatalf("mode = %d, want the insert-side prompt", m.diagramMode)
	}
	plain := ansi.Strip(m.Body())
	for _, want := range []string{"Insert a new step where?", "before brief", "after brief"} {
		if !strings.Contains(plain, want) {
			t.Fatalf("prompt missing %q:\n%s", want, plain)
		}
	}
	next, _ = m.Update(keyRune('b'))
	m = next.(Model)
	if m.diagramMode != diagramModeInstruction {
		t.Fatalf("mode = %d, want the composer", m.diagramMode)
	}
	if !strings.Contains(m.instructionDraft, "Insert a new step before brief") {
		t.Fatalf("draft = %q", m.instructionDraft)
	}
	if got := AnchorLabel(m.annotationBundle(nil)); got != "before brief" {
		t.Fatalf("anchor = %q, want before brief", got)
	}
	body := ansi.Strip(m.Body())
	draftLine, edgeLine := -1, -1
	for i, line := range strings.Split(body, "\n") {
		trimmed := strings.TrimRight(line, " ")
		if strings.HasPrefix(trimmed, tui.FieldCursor+" ") && strings.Contains(trimmed, "Insert a new step") {
			draftLine = i
		}
		if trimmed == tui.FormatFieldEdge(m.contentWidth()) {
			edgeLine = i
		}
	}
	if draftLine < 0 || edgeLine != draftLine+1 {
		t.Fatalf("composer draft=%d edge=%d\n%s", draftLine, edgeLine, body)
	}
}

func TestModelDiagramInsertSideEscapes(t *testing.T) {
	m := openHandoffDiagram(t)
	next, _ := m.Update(keyRune('a'))
	m = next.(Model)
	next, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyEsc})
	m = next.(Model)
	if m.diagramMode != diagramModeView {
		t.Fatalf("mode = %d, want the diagram", m.diagramMode)
	}
	if m.insertAt != "" {
		t.Fatalf("insertAt = %q, want cleared", m.insertAt)
	}
}

func TestModelDiagramArrowsStepCardToCard(t *testing.T) {
	m := openHandoffDiagram(t)
	next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyDown})
	m = next.(Model)
	if m.diagramFocus.Index != 1 {
		t.Fatalf("focus = %+v, want the next card with no gap between", m.diagramFocus)
	}
	next, _ = m.Update(keyRune('d'))
	m = next.(Model)
	if m.diagramMode != diagramModeInstruction {
		t.Fatal("d on a card must open the composer")
	}
}

func TestModelDiagramSendbackWholeWorkflow(t *testing.T) {
	var sent string
	m := openHandoffDiagram(t, func(o *Options) {
		o.PaneSendText = func(paneID, text string) error {
			sent = text
			return nil
		}
	})
	next, _ := m.Update(keyRune('s'))
	m = next.(Model)
	next, _ = m.Update(keyRune('x'))
	m = next.(Model)
	_, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	if !strings.Contains(sent, "Focus steps: (whole workflow)") {
		t.Fatalf("sent = %q", sent)
	}
	if strings.Contains(sent, "id: brief") {
		t.Fatal("bundle must not include YAML fragments")
	}
}

func TestReresolveFocusDropsMissingID(t *testing.T) {
	prev := workflow.Diagram{Nodes: []workflow.DiagramNode{
		{Index: 1, ID: "a"},
		{Index: 2, ID: "b"},
	}}
	next := workflow.Diagram{Nodes: []workflow.DiagramNode{
		{Index: 1, ID: "a"},
		{Index: 2, ID: "n"},
		{Index: 3, ID: "b"},
	}}
	if got := reresolveFocus(railFocus{Index: 1}, prev, next); got != (railFocus{Index: 2}) {
		t.Fatalf("moved id = %+v, want index 2", got)
	}
	gone := workflow.Diagram{Nodes: []workflow.DiagramNode{{Index: 1, ID: "b"}}}
	if got := reresolveFocus(railFocus{Index: 0}, prev, gone); got != (railFocus{}) {
		t.Fatalf("missing id = %+v, want drop", got)
	}
}

func TestModelDiagramWatchReloadsValidFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "wf.yaml")
	first := "version: v1alpha1\ntitle: One\nsteps:\n  - id: alpha\n    run: [echo, ok]\n"
	if err := os.WriteFile(path, []byte(first), 0o600); err != nil {
		t.Fatal(err)
	}
	def, err := workflow.ParseWorkflowText("one", first, config.Config{}, dir, path)
	if err != nil {
		t.Fatal(err)
	}
	m := New(Options{
		RepoRoot: dir,
		Entries:  []workflow.ListEntry{{Name: "one", Title: "One", Source: "repo", File: path}},
		Width:    80,
		Height:   24,
		LoadWorkflow: func(entry workflow.ListEntry) (*workflow.Definition, error) {
			return def, nil
		},
	})
	next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = next.(Model)
	second := "version: v1alpha1\ntitle: Two\nsteps:\n  - id: beta\n    run: [echo, ok]\n"
	time.Sleep(5 * time.Millisecond)
	if err := os.WriteFile(path, []byte(second), 0o600); err != nil {
		t.Fatal(err)
	}
	next, _ = m.Update(watchTickMsg{epoch: m.watchEpoch})
	m = next.(Model)
	if len(m.diagram.Nodes) != 1 || m.diagram.Nodes[0].ID != "beta" {
		t.Fatalf("diagram = %+v", m.diagram.Nodes)
	}
}

func TestModelDiagramWatchKeepsLastGoodOnInvalid(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "wf.yaml")
	first := "version: v1alpha1\ntitle: One\nsteps:\n  - id: alpha\n    run: [echo, ok]\n"
	if err := os.WriteFile(path, []byte(first), 0o600); err != nil {
		t.Fatal(err)
	}
	def, err := workflow.ParseWorkflowText("one", first, config.Config{}, dir, path)
	if err != nil {
		t.Fatal(err)
	}
	m := New(Options{
		RepoRoot: dir,
		Entries:  []workflow.ListEntry{{Name: "one", Title: "One", Source: "repo", File: path}},
		Width:    80,
		Height:   24,
		LoadWorkflow: func(entry workflow.ListEntry) (*workflow.Definition, error) {
			return def, nil
		},
	})
	next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = next.(Model)
	time.Sleep(5 * time.Millisecond)
	if err := os.WriteFile(path, []byte("this is not valid yaml: ["), 0o600); err != nil {
		t.Fatal(err)
	}
	next, _ = m.Update(watchTickMsg{epoch: m.watchEpoch})
	m = next.(Model)
	if len(m.diagram.Nodes) != 1 || m.diagram.Nodes[0].ID != "alpha" {
		t.Fatalf("last-good lost: %+v", m.diagram.Nodes)
	}
	if m.status == "" {
		t.Fatal("expected loader error status")
	}
}

func TestFileStampDetectsXORCollidingChange(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "wf.yaml")
	if err := os.WriteFile(path, []byte("1234"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, time.Unix(0, 100), time.Unix(0, 100)); err != nil {
		t.Fatal(err)
	}
	before, ok := fileStamp(path)
	if !ok {
		t.Fatal("no stamp")
	}
	// Size 4 at 100ns and size 5 at 101ns collide under mtime^size (100^4 == 101^5).
	if err := os.WriteFile(path, []byte("12345"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, time.Unix(0, 101), time.Unix(0, 101)); err != nil {
		t.Fatal(err)
	}
	after, ok := fileStamp(path)
	if !ok {
		t.Fatal("no stamp")
	}
	if before == after {
		t.Fatal("stamp missed a change whose mtime and size deltas cancel under XOR")
	}
}

func TestFileStampDetectsAtomicSavePreservingMtime(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "wf.yaml")
	if err := os.WriteFile(path, []byte("1234"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, time.Unix(0, 100), time.Unix(0, 100)); err != nil {
		t.Fatal(err)
	}
	before, ok := fileStamp(path)
	if !ok {
		t.Fatal("no stamp")
	}
	// Atomic save: write a temp file and rename that file to the target, then
	// restore the original mtime. Same size, same mtime, new inode.
	if err := os.WriteFile(path+".tmp", []byte("1234"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(path+".tmp", path); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, time.Unix(0, 100), time.Unix(0, 100)); err != nil {
		t.Fatal(err)
	}
	after, ok := fileStamp(path)
	if !ok {
		t.Fatal("no stamp")
	}
	if before == after {
		t.Fatal("stamp missed an atomic save that preserved mtime and size")
	}
}

func TestModelDiagramWatchKeepsYAMLScrollOnReload(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "wf.yaml")
	var prompt strings.Builder
	for i := range 60 {
		prompt.WriteString("      line ")
		prompt.WriteString(string(rune('a' + i%26)))
		prompt.WriteString("\n")
	}
	body := "version: v1alpha1\ntitle: Long\nsteps:\n  - id: long\n    agent: |\n" + prompt.String()
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	def, err := workflow.ParseWorkflowText("long", body, config.Config{}, dir, path)
	if err != nil {
		t.Fatal(err)
	}
	m := New(Options{
		RepoRoot: dir,
		Entries:  []workflow.ListEntry{{Name: "long", Title: "Long", Source: "repo", File: path}},
		Width:    100,
		Height:   24,
		LoadWorkflow: func(entry workflow.ListEntry) (*workflow.Definition, error) {
			return def, nil
		},
	})
	next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = next.(Model)
	next, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyPgDown})
	m = next.(Model)
	scrolled := m.diagramYAMLScroll
	if scrolled == 0 {
		t.Fatal("pgdown did not scroll the yaml pane")
	}
	time.Sleep(5 * time.Millisecond)
	reloaded := strings.Replace(body, "title: Long", "title: Longer", 1)
	if err := os.WriteFile(path, []byte(reloaded), 0o600); err != nil {
		t.Fatal(err)
	}
	next, _ = m.Update(watchTickMsg{epoch: m.watchEpoch})
	m = next.(Model)
	if m.diagramYAMLScroll != scrolled {
		t.Fatalf("reload reset yaml scroll: %d -> %d", scrolled, m.diagramYAMLScroll)
	}
}

func TestModelDiagramWatchTickIgnoresStaleEpoch(t *testing.T) {
	m := openWatchedDiagram(t)
	if m.watchEpoch == 0 {
		t.Fatal("diagram did not arm a watch epoch")
	}
	_, cmd := m.Update(watchTickMsg{epoch: m.watchEpoch - 1})
	if cmd != nil {
		t.Fatal("stale tick re-armed the poll")
	}
	_, cmd = m.Update(watchTickMsg{epoch: m.watchEpoch})
	if cmd == nil {
		t.Fatal("live tick did not re-arm the poll")
	}
}

func TestModelDiagramArrowsKeepScrollUntilFocusLeavesWindow(t *testing.T) {
	m := openHandoffDiagram(t)
	next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyDown})
	m = next.(Model)
	if m.diagramScroll != 0 {
		t.Fatalf("scroll = %d, want the rail to stay put while the focus shows", m.diagramScroll)
	}
	for range len(m.diagram.Nodes) {
		next, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyDown})
		m = next.(Model)
	}
	if m.diagramScroll == 0 {
		t.Fatal("scroll did not follow the focus off the window")
	}
}

func TestModelDiagramYAMLPaneScrolls(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "wf.yaml")
	var prompt strings.Builder
	for i := range 60 {
		prompt.WriteString("      line ")
		prompt.WriteString(string(rune('a' + i%26)))
		prompt.WriteString("\n")
	}
	body := "version: v1alpha1\ntitle: Long\nsteps:\n  - id: long\n    agent: |\n" + prompt.String()
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	def, err := workflow.ParseWorkflowText("long", body, config.Config{}, dir, path)
	if err != nil {
		t.Fatal(err)
	}
	m := New(Options{
		RepoRoot: dir,
		Entries:  []workflow.ListEntry{{Name: "long", Title: "Long", Source: "repo", File: path}},
		Width:    100,
		Height:   24,
		LoadWorkflow: func(entry workflow.ListEntry) (*workflow.Definition, error) {
			return def, nil
		},
	})
	next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = next.(Model)
	top := stripView(m.View())
	next, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyPgDown})
	m = next.(Model)
	if m.diagramYAMLScroll == 0 {
		t.Fatal("pgdown did not scroll the yaml pane")
	}
	if stripView(m.View()) == top {
		t.Fatal("yaml pane did not move")
	}
	leftW, _ := tui.RailSplit(m.contentWidth())
	next2, _ := m.ApplyMouse(tea.MouseWheelMsg{Button: tea.MouseWheelUp, X: leftW + tui.ChromePaddingX + 1})
	if next2.diagramYAMLScroll != m.diagramYAMLScroll-1 {
		t.Fatalf("wheel over the yaml pane = %d", next2.diagramYAMLScroll)
	}
	next3, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyUp})
	if next3.(Model).diagramYAMLScroll != 0 {
		t.Fatal("moving the focus must reset the yaml scroll")
	}
}

func TestSplitStepYAMLIndentAndNestedKey(t *testing.T) {
	flat := "version: v1alpha1\nsteps:\n- id: a\n  run: [echo, a]\n- id: b\n  run: [echo, b]\n"
	if got := tui.SplitStepYAML(flat); len(got) != 2 {
		t.Fatalf("zero-indent items = %d %q", len(got), got)
	}
	wide := "version: v1alpha1\nsteps:\n    - id: a\n      run: [echo, a]\n    - id: b\n      run: [echo, b]\n"
	if got := tui.SplitStepYAML(wide); len(got) != 2 {
		t.Fatalf("four-indent items = %d %q", len(got), got)
	}
	nested := "version: v1alpha1\ninputs:\n  n:\n    steps: nope\nsteps:\n  - id: a\n    run: [echo, a]\n"
	got := tui.SplitStepYAML(nested)
	if len(got) != 1 || !strings.Contains(got[0], "id: a") {
		t.Fatalf("nested steps key = %d %q", len(got), got)
	}
}

func TestRenderYAMLPaneRefusesMismatchedChunks(t *testing.T) {
	d := workflow.Diagram{Nodes: []workflow.DiagramNode{{Index: 1, ID: "a"}, {Index: 2, ID: "b"}}}
	got := renderYAMLPane(d, []string{"- id: a"}, DiagramMarks{}, 40, 6)
	if !strings.Contains(got, "step source unavailable") {
		t.Fatalf("pane = %q", got)
	}
}

func TestModelDiagramCardAnchorNamesTheStep(t *testing.T) {
	var sent string
	m := openHandoffDiagram(t, func(o *Options) {
		o.PaneSendText = func(paneID, text string) error {
			sent = text
			return nil
		}
	})
	next, _ := m.Update(keyRune('d'))
	m = next.(Model)
	if !strings.Contains(m.instructionDraft, "Delete step brief") {
		t.Fatalf("draft = %q", m.instructionDraft)
	}
	_, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	if !strings.Contains(sent, "Anchor: step brief") {
		t.Fatalf("sent = %q", sent)
	}
}

func openWatchedDiagram(t *testing.T) Model {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "wf.yaml")
	body := "version: v1alpha1\ntitle: One\nsteps:\n  - id: alpha\n    run: [echo, ok]\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	def, err := workflow.ParseWorkflowText("one", body, config.Config{}, dir, path)
	if err != nil {
		t.Fatal(err)
	}
	m := New(Options{
		RepoRoot: dir,
		Entries:  []workflow.ListEntry{{Name: "one", Title: "One", Source: "repo", File: path}},
		Width:    80,
		Height:   24,
		LoadWorkflow: func(entry workflow.ListEntry) (*workflow.Definition, error) {
			return def, nil
		},
	})
	next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	return next.(Model)
}

func TestModelDiagramToggleOnIDLessCardExplains(t *testing.T) {
	body := "version: v1alpha1\ntitle: Mixed\nsteps:\n  - id: alpha\n    run: [echo, a]\n  - run: [echo, b]\n"
	def, err := workflow.ParseWorkflowText("mixed", body, config.Config{}, t.TempDir(), "mixed.yaml")
	if err != nil {
		t.Fatal(err)
	}
	m := New(Options{
		RepoRoot:     t.TempDir(),
		Entries:      []workflow.ListEntry{{Name: "mixed", Title: "Mixed", Source: "repo"}},
		Width:        80,
		Height:       40,
		LoadWorkflow: func(entry workflow.ListEntry) (*workflow.Definition, error) { return def, nil },
	})
	next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = next.(Model)
	plain := ansi.Strip(m.Body())
	for _, mark := range []string{"[ ] alpha", "[-] "} {
		if !strings.Contains(plain, mark) {
			t.Fatalf("every card needs a mark slot, missing %q:\n%s", mark, plain)
		}
	}
	next, _ = m.Update(tea.KeyPressMsg{Code: 'v', Text: "v"})
	m = next.(Model)
	if !strings.Contains(ansi.Strip(m.Body()), "[x] alpha") {
		t.Fatalf("v on a card with an id must mark it:\n%s", ansi.Strip(m.Body()))
	}
	m = downTo(t, m, 1)
	next, _ = m.Update(tea.KeyPressMsg{Code: 'v', Text: "v"})
	m = next.(Model)
	if m.status != noStepIDStatus {
		t.Fatalf("status = %q, want %q", m.status, noStepIDStatus)
	}
	if len(m.diagramSelected) != 1 {
		t.Fatalf("selection = %v, want only the declared id", m.diagramSelected)
	}
}

// downTo moves the focus to the card at index i.
func downTo(t *testing.T, m Model, i int) Model {
	t.Helper()
	for m.diagramFocus.Index != i {
		next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyDown})
		m = next.(Model)
	}
	return m
}

func TestDiagramComposerNamesAnchorAndWrapsDraft(t *testing.T) {
	path := filepath.Join("..", "..", "examples", "handoff.yaml")
	m := openHandoffDiagram(t, func(o *Options) {
		o.Entries = []workflow.ListEntry{{Name: "handoff", Title: "Handoff", Source: "repo", File: path}}
	})
	next, _ := m.Update(tea.KeyPressMsg{Code: 's', Text: "s"})
	m = next.(Model)
	plain := ansi.Strip(m.Body())
	for _, want := range []string{"agent pane", "file: handoff.yaml", "anchor: step brief"} {
		if !strings.Contains(plain, want) {
			t.Fatalf("composer must state %q:\n%s", want, plain)
		}
	}
	for _, r := range strings.Repeat("draft ", 40) + "END" {
		next, _ = m.Update(tea.KeyPressMsg{Code: r, Text: string(r)})
		m = next.(Model)
	}
	plain = ansi.Strip(m.Body())
	if !strings.Contains(plain, "END") {
		t.Fatalf("a draft wider than the popup must stay visible:\n%s", plain)
	}
	if lines := strings.Count(m.Body(), "\n") + 1; lines > 24 {
		t.Fatalf("composer frame = %d lines, want at most 24", lines)
	}
}

func TestComposerKeepsTheFieldOnAShortPane(t *testing.T) {
	m := openHandoffDiagram(t, func(o *Options) { o.Height = 6 })
	next, _ := m.Update(tea.KeyPressMsg{Code: 's', Text: "s"})
	next, _ = next.(Model).Update(tea.KeyPressMsg{Code: 'x', Text: "x"})
	m = next.(Model)
	plain := ansi.Strip(m.Body())
	if !strings.Contains(plain, tui.FieldCursor) {
		t.Fatalf("caret missing:\n%s", plain)
	}
	if !strings.Contains(plain, "x") {
		t.Fatalf("draft missing:\n%s", plain)
	}
	edges := 0
	for _, line := range strings.Split(plain, "\n") {
		trim := strings.TrimSpace(line)
		if trim != "" && strings.Trim(trim, "-") == "" {
			edges++
		}
	}
	if edges < 2 {
		t.Fatalf("want both field edges:\n%s", plain)
	}
	if lines := strings.Count(m.View().Content, "\n") + 1; lines > 6 {
		t.Fatalf("composer frame = %d lines, want at most 6", lines)
	}
}

func TestComposerDraftWrapsWithAHangingIndent(t *testing.T) {
	// A character wrap split words and dropped continuations to column 0, so a
	// long draft stopped reading as one block under the caret.
	lines := composerDraft(strings.Repeat("wrap this draft across the composer. ", 6), 60)
	if len(lines) < 3 {
		t.Fatalf("draft did not wrap: %v", lines)
	}
	if !strings.HasPrefix(lines[0], tui.FieldCursor+"  ") {
		t.Fatalf("first row = %q", lines[0])
	}
	for i, line := range lines {
		if tui.Columns(line) > 60 {
			t.Fatalf("row %d is %d columns", i, tui.Columns(line))
		}
		if i > 0 && !strings.HasPrefix(line, strings.Repeat(" ", tui.RowTextIndent)) {
			t.Fatalf("row %d does not hang under the first: %q", i, line)
		}
		if strings.HasSuffix(strings.TrimRight(line, " "), "-") {
			t.Fatalf("row %d looks mid-word: %q", i, line)
		}
	}
	if strings.Contains(strings.Join(lines, "|"), "draf|") {
		t.Fatalf("word split across rows: %v", lines)
	}
}
