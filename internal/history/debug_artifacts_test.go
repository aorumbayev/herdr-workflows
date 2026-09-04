package history

import (
	"os"
	"testing"
)

func TestDebugArtifactsRoundTrip(t *testing.T) {
	state := t.TempDir()
	if err := os.Chmod(state, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HERDR_PLUGIN_STATE_DIR", state)
	id := AllocateRunID()
	yamlBody := "version: v1alpha1\nsteps:\n  - run: [echo, hi]\n"
	transcript := "user: hello\nassistant: world\n"
	if err := WriteDebugArtifacts(id, DebugArtifacts{
		EntryYAML:  yamlBody,
		Transcript: transcript,
	}); err != nil {
		t.Fatal(err)
	}
	got, err := LoadDebugArtifacts(id)
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
	if err := os.Chmod(state, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HERDR_PLUGIN_STATE_DIR", state)
	got, err := LoadDebugArtifacts(AllocateRunID())
	if err != nil {
		t.Fatal(err)
	}
	if got.HasEntryYAML || got.HasTranscript || got.EntryYAML != "" || got.Transcript != "" {
		t.Fatalf("got = %+v, want empty", got)
	}
}
