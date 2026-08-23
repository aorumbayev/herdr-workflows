package history

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/aorumbayev/herdr-workflows/internal/caps"
	"github.com/aorumbayev/herdr-workflows/internal/config"
	"github.com/aorumbayev/herdr-workflows/internal/credentials"
)

// DebugArtifacts are private per-run console debug payloads.
type DebugArtifacts struct {
	EntryYAML     string
	Transcript    string
	HasEntryYAML  bool
	HasTranscript bool
}

func entryYAMLPath(id string, getenv config.Env) string {
	return filepath.Join(RunsDir(getenv), id+".entry.yaml")
}

func transcriptPath(id string, getenv config.Env) string {
	return filepath.Join(RunsDir(getenv), id+".transcript.txt")
}

// WriteDebugArtifacts stores capped yaml-at-run and transcript sidecars.
func WriteDebugArtifacts(id string, arts DebugArtifacts, getenv config.Env) error {
	if getenv == nil {
		getenv = os.Getenv
	}
	normalized, ok := NormalizeRunUUID(id)
	if !ok {
		return fmt.Errorf("run identity must be a complete UUID")
	}
	if _, err := ensureRunsDir(getenv); err != nil {
		return err
	}
	if arts.EntryYAML != "" {
		if err := caps.AssertUnderCaptureCap("yaml-at-run", arts.EntryYAML); err != nil {
			return err
		}
		path := entryYAMLPath(normalized, getenv)
		if err := os.WriteFile(path, []byte(arts.EntryYAML), 0o600); err != nil {
			return err
		}
		if err := credentials.AssertPrivateCredentialFile(path, historyACLOpts()); err != nil {
			return err
		}
	}
	if arts.Transcript != "" {
		if err := caps.AssertUnderCaptureCap("transcript", arts.Transcript); err != nil {
			return err
		}
		path := transcriptPath(normalized, getenv)
		if err := os.WriteFile(path, []byte(arts.Transcript), 0o600); err != nil {
			return err
		}
		if err := credentials.AssertPrivateCredentialFile(path, historyACLOpts()); err != nil {
			return err
		}
	}
	return nil
}

// LoadDebugArtifacts reads yaml-at-run and transcript sidecars when present.
func LoadDebugArtifacts(id string, getenv config.Env) (DebugArtifacts, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	normalized, ok := NormalizeRunUUID(id)
	if !ok {
		return DebugArtifacts{}, fmt.Errorf("run identity must be a complete UUID")
	}
	var out DebugArtifacts
	if raw, err := os.ReadFile(entryYAMLPath(normalized, getenv)); err == nil {
		out.EntryYAML = string(raw)
		out.HasEntryYAML = true
	} else if !os.IsNotExist(err) {
		return DebugArtifacts{}, err
	}
	if raw, err := os.ReadFile(transcriptPath(normalized, getenv)); err == nil {
		out.Transcript = string(raw)
		out.HasTranscript = true
	} else if !os.IsNotExist(err) {
		return DebugArtifacts{}, err
	}
	return out, nil
}

func removeDebugArtifacts(id string, getenv config.Env) {
	_ = os.Remove(entryYAMLPath(id, getenv))
	_ = os.Remove(transcriptPath(id, getenv))
}
