package history

import (
	"fmt"
	"os"

	"github.com/aorumbayev/herdr-workflows/internal/caps"
	"github.com/aorumbayev/herdr-workflows/internal/config"
)

const (
	artifactEntryYAML  = "entry.yaml"
	artifactTranscript = "transcript"
)

type DebugArtifacts struct {
	EntryYAML     string
	Transcript    string
	HasEntryYAML  bool
	HasTranscript bool
}

func WriteDebugArtifacts(id string, arts DebugArtifacts, getenv config.Env) error {
	if getenv == nil {
		getenv = os.Getenv
	}
	normalized, ok := NormalizeRunUUID(id)
	if !ok {
		return fmt.Errorf("run identity must be a complete UUID")
	}
	db, err := openHistory(getenv)
	if err != nil {
		return err
	}
	if arts.EntryYAML != "" {
		if err := caps.AssertUnderCaptureCap("yaml-at-run", arts.EntryYAML); err != nil {
			return err
		}
		if err := putArtifact(db, normalized, artifactEntryYAML, arts.EntryYAML); err != nil {
			return err
		}
	}
	if arts.Transcript != "" {
		if err := caps.AssertUnderCaptureCap("transcript", arts.Transcript); err != nil {
			return err
		}
		if err := putArtifact(db, normalized, artifactTranscript, arts.Transcript); err != nil {
			return err
		}
	}
	return nil
}

func LoadDebugArtifacts(id string, getenv config.Env) (DebugArtifacts, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	normalized, ok := NormalizeRunUUID(id)
	if !ok {
		return DebugArtifacts{}, fmt.Errorf("run identity must be a complete UUID")
	}
	db, err := openHistory(getenv)
	if err != nil {
		return DebugArtifacts{}, err
	}
	var out DebugArtifacts
	if body, ok, err := getArtifact(db, normalized, artifactEntryYAML); err != nil {
		return DebugArtifacts{}, err
	} else if ok {
		out.EntryYAML = body
		out.HasEntryYAML = true
	}
	if body, ok, err := getArtifact(db, normalized, artifactTranscript); err != nil {
		return DebugArtifacts{}, err
	} else if ok {
		out.Transcript = body
		out.HasTranscript = true
	}
	return out, nil
}
