package console

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/aorumbayev/herdr-workflows/internal/caps"
	"github.com/aorumbayev/herdr-workflows/internal/engine"
	"github.com/aorumbayev/herdr-workflows/internal/tui"
)

const skillPointer = "hwf skills show herdr-workflow-create"

type AnnotationBundle struct {
	Title       string
	File        string
	Focus       []string
	AnchorKind  string
	AnchorID    string
	Instruction string
	Failure     *FailureBlock
}

type FailureBlock struct {
	Run      string
	Checkout string
	Step     string
	Cause    string
	ExitCode string
	Source   string
}

func FormatAnnotationBundle(b AnnotationBundle) string {
	var buf strings.Builder
	fmt.Fprintf(&buf, "Workflow: %s\n", b.Title)
	if b.File != "" {
		fmt.Fprintf(&buf, "File: %s\n", b.File)
	}
	fmt.Fprintf(&buf, "Skill: %s\n", skillPointer)
	fmt.Fprintf(&buf, "Anchor: %s\n", AnchorLabel(b))
	if len(b.Focus) > 0 {
		fmt.Fprintf(&buf, "Focus steps: %s\n", strings.Join(b.Focus, ", "))
	} else {
		fmt.Fprintf(&buf, "Focus steps: (whole workflow)\n")
	}
	fmt.Fprintf(&buf, "\n--- instruction ---\n%s\n", strings.TrimSpace(b.Instruction))
	if b.Failure != nil {
		fmt.Fprintf(&buf, "\n--- failure ---\n")
		fmt.Fprintf(&buf, "Run: %s\n", b.Failure.Run)
		fmt.Fprintf(&buf, "Checkout: %s\n", b.Failure.Checkout)
		fmt.Fprintf(&buf, "Step: %s\n", b.Failure.Step)
		fmt.Fprintf(&buf, "Cause: %s\n", b.Failure.Cause)
		if b.Failure.ExitCode != "" {
			fmt.Fprintf(&buf, "Exit code: %s\n", b.Failure.ExitCode)
		}
		if b.Failure.Source != "" {
			fmt.Fprintf(&buf, "Step source:\n%s\n", b.Failure.Source)
		}
	}
	return buf.String()
}

func AnchorLabel(b AnnotationBundle) string {
	switch b.AnchorKind {
	case "before", "after":
		return b.AnchorKind + " " + b.AnchorID
	case "step":
		return "step " + b.AnchorID
	default:
		return "workflow"
	}
}

func composerScope(b AnnotationBundle) string {
	parts := []string{}
	if b.File != "" {
		parts = append(parts, "file: "+filepath.Base(b.File))
	}
	parts = append(parts, "anchor: "+AnchorLabel(b))
	if len(b.Focus) > 0 {
		parts = append(parts, "focus: "+strings.Join(b.Focus, ", "))
	}
	return strings.Join(parts, tui.ChromeSep)
}

func insertSeed(card string, side insertSide) string {
	if card == "" || side == "" {
		return "Append a new step at the end of this workflow."
	}
	return "Insert a new step " + string(side) + " " + card + "."
}

func deleteSeed(title string) string {
	if title == "" {
		return "Delete the focused step from this workflow."
	}
	return "Delete step " + title + " from this workflow."
}

func MaybeSpillSendbackText(repoRoot, text string) (string, string, error) {
	if len(text) <= caps.AgentPromptByteLimit {
		return text, "", nil
	}
	if err := caps.AssertUnderCaptureCap("send-back annotation", text); err != nil {
		return "", "", err
	}
	dir, err := engine.EnsureRunScratchDir(repoRoot, "")
	if err != nil {
		return "", "", err
	}
	var nonce [8]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return "", "", err
	}
	spill := filepath.Join(dir, "sendback-"+hex.EncodeToString(nonce[:])+".txt")
	if err := os.WriteFile(spill, []byte(text), 0o600); err != nil {
		return "", "", err
	}
	return engine.SpilledPromptInstruction(spill), spill, nil
}
