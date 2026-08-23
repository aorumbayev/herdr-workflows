package history

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDebugArtifactsRoundTrip(t *testing.T) {
	state := t.TempDir()
	getenv := func(k string) string {
		if k == "HERDR_PLUGIN_STATE_DIR" {
			return state
		}
		return ""
	}
	id := AllocateRunID()
	yamlBody := "version: v1alpha1\nsteps:\n  - run: [echo, hi]\n"
	transcript := "user: hello\nassistant: world\n"
	if err := WriteDebugArtifacts(id, DebugArtifacts{
		EntryYAML:  yamlBody,
		Transcript: transcript,
	}, getenv); err != nil {
		t.Fatal(err)
	}
	got, err := LoadDebugArtifacts(id, getenv)
	if err != nil {
		t.Fatal(err)
	}
	if got.EntryYAML != yamlBody {
		t.Fatalf("EntryYAML = %q", got.EntryYAML)
	}
	if got.Transcript != transcript {
		t.Fatalf("Transcript = %q", got.Transcript)
	}
	if !got.HasEntryYAML || !got.HasTranscript {
		t.Fatalf("flags = %+v", got)
	}
}

func TestLoadDebugArtifactsMissing(t *testing.T) {
	state := t.TempDir()
	getenv := func(k string) string {
		if k == "HERDR_PLUGIN_STATE_DIR" {
			return state
		}
		return ""
	}
	if err := os.MkdirAll(filepath.Join(state, "runs"), 0o700); err != nil {
		t.Fatal(err)
	}
	got, err := LoadDebugArtifacts(AllocateRunID(), getenv)
	if err != nil {
		t.Fatal(err)
	}
	if got.HasEntryYAML || got.HasTranscript || got.EntryYAML != "" || got.Transcript != "" {
		t.Fatalf("got = %+v, want empty", got)
	}
}
