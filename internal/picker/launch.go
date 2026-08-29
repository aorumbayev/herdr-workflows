package picker

import (
	"os"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/history"
	"github.com/aorumbayev/herdr-workflows/internal/runsbrowser"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

// LaunchRunOpts is the detached-run request that the picker supplies.
type LaunchRunOpts struct {
	Name     string
	RepoRoot string
	RunID    string
	Inputs   map[string]string
	Domains  map[string][]string
}

// LaunchEvent is one detached-launch observation. Ack is a child history ack
// line. Fail is why the child never sent one.
type LaunchEvent struct {
	Ack  string
	Fail string
}

// LaunchRunHandle is the detached-launch observer.
// A non-nil Events channel requires beginLaunch to give a listen tea.Cmd.
type LaunchRunHandle struct {
	Detach func()
	Events <-chan LaunchEvent
}

type launchAckMsg struct {
	Line string
}

type launchFailedMsg struct {
	Detail string
}

func (m Model) beginLaunch(def *workflow.Definition, values map[string]string, domains map[string][]string) (tea.Model, tea.Cmd) {
	alloc := m.allocateRunID
	if alloc == nil {
		alloc = history.AllocateRunID
	}
	runID := alloc()
	name := def.Name
	title := workflow.DisplayTitle(def.Name, def.Title)
	if title == "" {
		title = name
	}

	getenv := m.env
	if getenv == nil {
		getenv = os.Getenv
	}
	m.runs = runsbrowser.New(runsbrowser.Options{
		RepoRoot: m.repoRoot,
		Width:    m.width,
		Height:   m.height,
		Env:      getenv,
		Now:      m.now,
	}).OpenLocalDetail(runsbrowser.DetailView{
		Kind:     "starting",
		ID:       runID,
		Workflow: title,
		Message:  m.consent,
	})
	m.mode = modeRuns
	m.launchRunID = runID
	m.status = ""

	inputs := values
	if inputs == nil {
		inputs = map[string]string{}
	}
	opts := LaunchRunOpts{
		Name:     name,
		RepoRoot: m.repoRoot,
		RunID:    runID,
		Inputs:   inputs,
		Domains:  domains,
	}
	if m.launchRun == nil {
		return m, nil
	}
	handle := m.launchRun(opts)
	m.launchDetach = handle.Detach
	m.launchEvents = handle.Events
	return m, m.listenLaunch()
}

func (m Model) listenLaunch() tea.Cmd {
	if m.launchDetach == nil {
		return nil
	}
	events := m.launchEvents
	if events == nil {
		return nil
	}
	return func() tea.Msg {
		event, ok := <-events
		if !ok {
			return nil
		}
		if event.Fail != "" {
			return launchFailedMsg{Detail: event.Fail}
		}
		return launchAckMsg{Line: event.Ack}
	}
}

// applyLaunchAck closes the popup once the child owns a run. Run detail lives in
// the runs tab, so only a launch with no history entry keeps a surface here.
func (m Model) applyLaunchAck(msg launchAckMsg) (tea.Model, tea.Cmd) {
	ack := history.ParseHistoryAck(msg.Line)
	if ack == nil {
		return m, m.listenLaunch()
	}
	id := ack.ID
	if id == "" {
		id = m.launchRunID
	}
	if m.launchRunID != "" && id != m.launchRunID {
		return m, m.listenLaunch()
	}
	title := m.runs.DetailWorkflow()
	switch ack.State {
	case "claimed":
		m.detachLaunch()
		m.quit = true
		return m, tea.Quit
	case "unavailable":
		m.runs = m.runs.ApplyLocalDetail(runsbrowser.DetailView{
			Kind:     "history-unavailable",
			ID:       id,
			Workflow: title,
		})
	case "rejected":
		m.runs = m.runs.ApplyLocalDetail(runsbrowser.DetailView{
			Kind:     "local-failure",
			ID:       id,
			Workflow: title,
			Message:  ack.Error,
		})
		m.clearLaunchDetach()
		return m, nil
	}
	return m, m.listenLaunch()
}

// applyLaunchFailed shows why a child died before it claimed a run. A child that
// claimed already closed the popup, and a later ack owns the surface it wrote.
func (m Model) applyLaunchFailed(msg launchFailedMsg) (tea.Model, tea.Cmd) {
	if kind := m.runs.DetailKind(); kind != "starting" && kind != "" {
		m.clearLaunchDetach()
		return m, nil
	}
	m.runs = m.runs.ApplyLocalDetail(runsbrowser.DetailView{
		Kind:     "local-failure",
		ID:       m.launchRunID,
		Workflow: m.runs.DetailWorkflow(),
		Message:  msg.Detail,
	})
	m.clearLaunchDetach()
	return m, nil
}

func (m *Model) clearLaunchDetach() {
	m.launchDetach = nil
	m.launchEvents = nil
}

func (m *Model) detachLaunch() {
	if m.launchDetach != nil {
		m.launchDetach()
		m.launchDetach = nil
	}
	m.launchEvents = nil
}
