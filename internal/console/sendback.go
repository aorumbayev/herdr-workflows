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
)

// FormatAnnotationBundle assembles the send-back payload from selected steps.
func FormatAnnotationBundle(workflowTitle string, ids []string, fragments map[string]string, instruction string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Workflow: %s\n", workflowTitle)
	fmt.Fprintf(&b, "Selected steps: %s\n", strings.Join(ids, ", "))
	for _, id := range ids {
		fmt.Fprintf(&b, "\n--- %s ---\n", id)
		b.WriteString(strings.TrimSpace(fragments[id]))
		b.WriteByte('\n')
	}
	fmt.Fprintf(&b, "\n--- instruction ---\n%s\n", strings.TrimSpace(instruction))
	return b.String()
}

// MaybeSpillSendbackText keeps text inline under the agent prompt cap or spills it to a private file.
func MaybeSpillSendbackText(repoRoot, text string) (string, error) {
	if len(text) <= caps.AgentPromptByteLimit {
		return text, nil
	}
	if err := caps.AssertUnderCaptureCap("send-back annotation", text); err != nil {
		return "", err
	}
	dir, err := engine.EnsureRunScratchDir(repoRoot, "")
	if err != nil {
		return "", err
	}
	var nonce [8]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return "", err
	}
	spill := filepath.Join(dir, "sendback-"+hex.EncodeToString(nonce[:])+".txt")
	if err := os.WriteFile(spill, []byte(text), 0o600); err != nil {
		return "", err
	}
	return engine.SpilledPromptInstruction(spill), nil
}
