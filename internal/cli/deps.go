package cli

import (
	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/engine"
	"github.com/aorumbayev/herdr-workflows/internal/host"
	"github.com/aorumbayev/herdr-workflows/internal/transcript"
)

func liveRunnerDeps() engine.RunnerDeps {
	return engine.RunnerDeps{
		HerdrCall: host.HerdrCall,
		NotificationShow: func(title string, body *string) error {
			if body == nil {
				return host.NotificationShow(title)
			}
			return host.NotificationShow(title, *body)
		},
		AgentStatus:    host.AgentStatus,
		AgentInfo:      liveAgentInfo,
		PaneClose:      host.PaneClose,
		TabClose:       host.TabClose,
		ReportToken:    host.ReportToken,
		TranscriptText: liveTranscriptText,
	}
}

func liveAgentInfo(target string) (map[string]any, error) {
	result, err := host.HerdrCall("agent.get", map[string]any{"target": target})
	if err != nil {
		return nil, err
	}
	agent, _ := result["agent"].(map[string]any)
	if agent == nil {
		return map[string]any{}, nil
	}
	return agent, nil
}

func liveTranscriptText(paneID string, transcripts map[string]config.TranscriptExtractor, opts engine.TranscriptTextOpts) (string, error) {
	return transcript.TranscriptText(paneID, transcripts, transcript.Options{
		InvocationCwd: opts.InvocationCwd,
		ProjectsBase:  opts.ProjectsBase,
	})
}
