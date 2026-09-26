package cli

import (
	"os"
	"time"

	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/engine"
	"github.com/aorumbayev/herdr-workflows/internal/history"
	"github.com/aorumbayev/herdr-workflows/internal/host"
	"github.com/spf13/cobra"
)

// runDetachedJSON launches the child with the picker's protocol and answers
// only after the child has claimed the run in history.
func runDetachedJSON(cmd *cobra.Command, name string, rawInputs []string) error {
	inputs, err := parseInputs(rawInputs)
	if err != nil {
		return machineErr("invalid_request", err.Error())
	}
	if err := host.EnsureHerdrProtocol(); err != nil {
		return machineErr("launch_rejected", err.Error())
	}
	app, err := config.LoadContext(config.LoadOptions{FromInvocation: true})
	if err != nil {
		return machineErr("launch_rejected", err.Error())
	}
	execPath, err := os.Executable()
	if err != nil {
		return machineErr("launch_rejected", err.Error())
	}
	runID := history.AllocateRunID()
	acks := make(chan string, 8)
	handle := engine.LaunchDetachedRun(engine.LaunchRunRequest{
		Name:           name,
		RepoRoot:       app.RepoRoot,
		Executable:     execPath,
		Ctx:            app.Ctx,
		Inputs:         inputs,
		RunID:          runID,
		RequireHistory: true,
		OnHistoryAck:   func(line string) { acks <- line },
	})
	for {
		select {
		case line := <-acks:
			ack := history.ParseHistoryAck(line)
			if ack == nil || (ack.ID != "" && ack.ID != runID) {
				continue
			}
			switch ack.State {
			case "claimed":
				handle.Detach()
				return writeLaunchedRun(cmd, runID)
			case "unavailable":
				return machineErr("launch_rejected", "run history storage is unavailable")
			default:
				return machineErr("launch_rejected", ack.Error)
			}
		case <-handle.Result:
			return machineErr("launch_rejected", "run exited before it claimed a history record")
		}
	}
}

func writeLaunchedRun(cmd *cobra.Command, runID string) error {
	snap, err := history.ReadSnapshot(runID)
	if err != nil || snap == nil {
		return machineErr("history_unavailable", "run "+runID+" was claimed but cannot be read back")
	}
	summary := history.ToSummary(*snap, time.Now())
	return writeMachine(cmd.OutOrStdout(), runResponse{SchemaVersion: machineSchemaVersion, OK: true, Run: summary})
}
