package picker

import (
	"os"

	tea "charm.land/bubbletea/v2"

	"github.com/aorumbayev/herdr-workflows/internal/history"
	"github.com/aorumbayev/herdr-workflows/internal/runsbrowser"
	"github.com/aorumbayev/herdr-workflows/internal/workflow"
)

// LaunchRunOpts is the injectable detached-run request from the picker.
type LaunchRunOpts struct {
	Name     string
	RepoRoot string
	RunID    string
	Inputs   map[string]string
	Domains  map[string][]string
}

// LaunchSettled is the detached-run outcome delivered through LaunchRunHandle.Settled.
type LaunchSettled struct {
	OK     bool
	Detail string
	RunID  string
}

// LaunchRunHandle observes a detached launch; Detach stops attached observation.
// Non-nil Acks/Settled/Progress require beginLaunch to return a listen tea.Cmd.
type LaunchRunHandle struct {
	Detach   func()
	Acks     <-chan string
	Settled  <-chan LaunchSettled
	Progress <-chan string
}

type launchAckMsg struct {
	Line string
}

type launchSettledMsg struct {
	OK     bool
	Detail string
	RunID  string
}

type launchProgressMsg struct {
	Line  string
	RunID string
}

func (m Model) beginLaunch(def *workflow.Definition, values map[string]string, domains map[string][]string) (tea.Model, tea.Cmd) {
	alloc := m.allocateRunID
	if alloc == nil {
		alloc = history.AllocateRunID
	}
	runID := alloc()
	name := def.Name
	title := workflow.WorkflowDisplayTitle(def.Name, def.Title)
	if title == "" {
		title = name
	}

	getenv := m.env
	if getenv == nil {
		getenv = os.Getenv
	}
	m.runs = runsbrowser.New(runsbrowser.Options{
		RepoRoot:        m.repoRoot,
		Width:           m.width,
		Height:          m.height,
		Env:             getenv,
		LaunchWorkbench: m.launchWorkbench,
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
	m.launchAcks = handle.Acks
	m.launchSettled = handle.Settled
	m.launchProgress = handle.Progress
	return m, m.listenLaunch()
}

func (m Model) listenLaunch() tea.Cmd {
	if m.launchDetach == nil {
		return nil
	}
	acks := m.launchAcks
	settled := m.launchSettled
	progress := m.launchProgress
	if acks == nil && settled == nil && progress == nil {
		return nil
	}
	runID := m.launchRunID
	return func() tea.Msg {
		for {
			select {
			case line, ok := <-acks:
				if !ok {
					acks = nil
					if acks == nil && settled == nil && progress == nil {
						return nil
					}
					continue
				}
				return launchAckMsg{Line: line}
			case r, ok := <-settled:
				if !ok {
					settled = nil
					if acks == nil && settled == nil && progress == nil {
						return nil
					}
					continue
				}
				id := r.RunID
				if id == "" {
					id = runID
				}
				return launchSettledMsg{OK: r.OK, Detail: r.Detail, RunID: id}
			case line, ok := <-progress:
				if !ok {
					progress = nil
					if acks == nil && settled == nil && progress == nil {
						return nil
					}
					continue
				}
				return launchProgressMsg{Line: line, RunID: runID}
			}
		}
	}
}

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
		m.runs = m.runs.ApplyLocalDetail(runsbrowser.DetailView{
			Kind:     "detail",
			ID:       id,
			Workflow: title,
			Blocks: []history.Block{{
				Kind: "head", Status: "RUNNING", Title: title, DisplayID: shortRunID(id),
			}},
		})
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

func (m Model) applyLaunchSettled(msg launchSettledMsg) (tea.Model, tea.Cmd) {
	if m.launchRunID != "" && msg.RunID != "" && msg.RunID != m.launchRunID {
		return m, m.listenLaunch()
	}
	title := m.runs.DetailWorkflow()
	id := msg.RunID
	if id == "" {
		id = m.launchRunID
	}
	if msg.OK {
		kind := m.runs.DetailKind()
		switch kind {
		case "starting", "", "detail":
			m.runs = m.runs.ApplyLocalDetail(runsbrowser.DetailView{
				Kind:     "detail",
				ID:       id,
				Workflow: title,
				Blocks: []history.Block{{
					Kind: "head", Status: "SUCCEEDED", Title: title, DisplayID: shortRunID(id),
				}},
			})
		case "history-unavailable":
			m.runs = m.runs.ApplyLocalDetail(runsbrowser.DetailView{
				Kind:     "history-unavailable",
				ID:       id,
				Workflow: title,
				Finished: "succeeded",
			})
		}
		m.clearLaunchDetach()
		return m, nil
	}
	if m.runs.DetailKind() == "starting" || m.runs.DetailKind() == "" {
		m.runs = m.runs.ApplyLocalDetail(runsbrowser.DetailView{
			Kind:     "local-failure",
			ID:       id,
			Workflow: title,
			Message:  msg.Detail,
		})
	}
	m.clearLaunchDetach()
	return m, nil
}

func (m *Model) clearLaunchDetach() {
	m.launchDetach = nil
	m.launchAcks = nil
	m.launchSettled = nil
	m.launchProgress = nil
}

func (m *Model) detachLaunch() {
	if m.launchDetach != nil {
		m.launchDetach()
		m.launchDetach = nil
	}
	m.launchAcks = nil
	m.launchSettled = nil
	m.launchProgress = nil
}

func shortRunID(id string) string {
	if len(id) >= 8 {
		return id[:8]
	}
	return id
}
